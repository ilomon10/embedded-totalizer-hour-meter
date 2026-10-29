#!/usr/bin/env python3
"""Fault simulations for the rev-B hour meter (main board + PSU-B), with ngspice.

  python3 faults.py            -> runs every scenario, prints the results table, writes plots/*.png

Each scenario is a small SPICE deck built from the parts on the real schematics (values and
LCSC parts as in hour-meter-board / hour-meter-psu-b). Semiconductor models are fitted to the
datasheet points named next to them; they are good for stresses and pass/fail margins, not for
exact waveforms. Decks and raw waveforms go to work/ (git-ignored).
"""
import math
import os
import subprocess

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, "work")
PLOTS = os.path.join(HERE, "plots")

MODELS = """
* SMBJ36CA (PSU-B D1): VBR 40-44.2 V @ 1 mA, VC 58.1 V @ 10.3 A; two zeners back to back
.model TVS36 D(Is=1e-12 N=1 Rs=0.75 BV=42 IBV=1m Cjo=2n)
* PSM712 (main D701, RS485): +13.3 V / -7.5 V minimum breakdown, about 25 V / 15 V at 7 A
.model TVS712P D(Is=1e-12 N=1 Rs=1.5 BV=12.7 IBV=1m)
.model TVS712N D(Is=1e-12 N=1 Rs=1.0 BV=6.9 IBV=1m)
* SMAJ33CA (compact D701 / D702): VBR 36.7 V min @ 1 mA, VC 53.3 V @ 7.5 A; two zeners back to back
.model TVS33 D(Is=1e-12 N=1 Rs=1.0 BV=36.0 IBV=1m Cjo=400p)
* SRV05-4 (main U802): steering diodes + 6 V rail clamp, about 12.5 V at 1 A
.model SRVD D(Is=1e-10 N=1.2 Rs=0.5)
.model SRVZ D(Is=1e-12 N=1 Rs=1.5 BV=6.5 IBV=1m)
* SS510 (PSU-B D2), SS34 (main D101): Schottky, about 0.5-0.55 V at rated current
.model SS510 D(Is=1.5e-5 N=1.15 Rs=0.025 BV=100 Cjo=250p)
.model SS34 D(Is=1e-5 N=1.05 Rs=0.04 BV=40 Cjo=200p)
* M7 (main D301/D303): 1000 V 1 A rectifier
.model M7 D(Is=5e-9 N=1.8 Rs=0.05 BV=1000 IBV=5u)
* BZT52C4V7S (main D302/D304): 4.7 V @ 5 mA, soft knee
.model DZ47 D(Is=1e-14 N=1 Rs=12 BV=4.7 IBV=5m)
* PC817C input LED: 1.2 V @ 20 mA, about 1.0 V @ 1 mA
.model LED817 D(Is=1e-13 N=1.7 Rs=2)
* BAV99 (I/O variant D901): about 0.62 V @ 1 mA, 0.75 V @ 10 mA (onsemi max 0.715 / 0.855 V)
.model BAV99 D(Is=2.4e-9 N=1.85 Rs=2 BV=100 IBV=1u Cjo=1.5p)
* SMAJ30CA (LM2596 boards D104): VBR 33.3-36.8 V @ 1 mA, VC 48.4 V @ 8.3 A; a typical (35 V) and a lowest-breakdown part
.model TVS30 D(Is=1e-12 N=1 Rs=0.7 BV=34.3 IBV=1m Cjo=400p)
.model TVS30L D(Is=1e-12 N=1 Rs=0.7 BV=32.8 IBV=1m Cjo=400p)
* SS54 (LM2596 boards D103): 40 V Schottky, 0.55 V @ 5 A max; no avalanche rating, breakdown taken as 50 V
.model SS54 D(Is=1e-5 N=1.1 Rs=0.03 BV=50 IBV=1m Cjo=300p)
* 1N4148W (D102, VIN_SENSE)
.model D4148 D(Is=2.5e-9 N=1.75 Rs=0.6 BV=100 IBV=5u)
* Indicator LEDs (Micro-Fit D801-D803, all LTST-S270TGKT green): LCSC's VF of 3.2 V at 20 mA with a generic InGaN slope
* (about 0.31 V per decade); a part at 2.8 V or 3.8 V shows the spread of InGaN parts
.model LEDG D(Is=4.5e-12 N=5.22 Rs=10)
.model LEDGLO D(Is=8.7e-11 N=5.22 Rs=10)
.model LEDGHI D(Is=5.2e-14 N=5.22 Rs=10)
"""


def run(name, netlist, control):
    """Write a deck, run ngspice in batch mode and return {measure: value}; waveforms land in work/<name>.dat."""
    os.makedirs(WORK, exist_ok=True)
    deck = os.path.join(WORK, name + ".cir")
    data = os.path.join(WORK, name + ".dat")
    with open(deck, "w") as f:
        f.write(f"* {name}\n{MODELS}\n{netlist}\n.control\nset filetype=ascii\nset wr_singlescale\nset wr_vecnames\n"
                f"{control.replace('DATA', data)}\nquit\n.endc\n.end\n")
    out = subprocess.run(["ngspice", "-b", deck], capture_output=True, text=True, timeout=600).stdout
    if "aborted" in out or "Timestep too small" in out or "failed!" in out:
        raise SystemExit(f"ngspice trouble in {deck}:\n" + "\n".join(l for l in out.splitlines() if "rror" in l or "abort" in l or "small" in l or "failed" in l))
    values = {}
    for line in out.splitlines():
        if "=" in line and not line.lstrip().startswith(("*", "Warning", "Note")):
            key, _, rest = line.partition("=")
            key = key.strip().lower()
            try:
                values[key] = float(rest.split()[0])
            except (ValueError, IndexError):
                pass
    return values


def waveforms(name):
    rows = np.loadtxt(os.path.join(WORK, name + ".dat"), skiprows=1)
    with open(os.path.join(WORK, name + ".dat")) as f:
        names = f.readline().split()
    return {n: rows[:, i] for i, n in enumerate(names)}


def tvs_rating_j(duration_s, ppk=600):
    """SMBJ: 600 W for a 10/1000 us pulse (about 0.85 J; SMAJ: 400 W). Its pulse-power curve falls about as t^-1/2,
    so the energy it survives grows about as sqrt(t); beyond ~10 ms this is an extrapolation."""
    return 0.85 * ppk / 600 * math.sqrt(max(duration_s, 1e-3) / 1e-3)


# --- Supply path: J101 -> F101 PTC -> VIN_RAW -> J102 -> PSU-B D1 TVS, D2 -> C1..C4 -> TPS54360B ----
SUPPLY = """
RPTC gen_r vin_raw {rptc}
VTVS vin_raw tvs_top 0
D1a tvs_mid tvs_top TVS36
D1b tvs_mid 0 TVS36
VD2 vin_raw d2a 0
D2 d2a vinp SS510
C1 vinp c1esr 100u
RC1 c1esr 0 0.3
C23 vinp 0 2.2u
C4 vinp 0 100n
* TPS54360B + board as a constant-power load (3 W in), fading out below its 6.3 V UVLO
BLOAD vinp 0 I = 3 / max(V(vinp), 8) * 0.5 * (1 + tanh((V(vinp) - 6.3) / 0.3))
"""


def supply_case(name, gen_expr, ri, ua, tstop, tstep, rptc=0.25):
    netlist = (f"BGEN gen 0 V = {gen_expr}\nRI gen gen_r {ri}\n"
               + SUPPLY.format(rptc=rptc))
    control = (f"tran {tstep} {tstop}\n"
               "let p_tvs = v(vin_raw) * i(vtvs)\n"
               "meas tran itvs_max max i(vtvs)\nmeas tran itvs_min min i(vtvs)\n"
               "meas tran ptvs_max max p_tvs\nmeas tran ptvs_min min p_tvs\n"
               f"meas tran e_tvs integ p_tvs from=0 to={tstop}\n"
               "meas tran vinp_max max v(vinp)\nmeas tran vinp_min min v(vinp)\n"
               "meas tran vraw_max max v(vin_raw)\nmeas tran vraw_min min v(vin_raw)\n"
               "wrdata DATA v(gen) v(vin_raw) v(vinp) i(vtvs)\n")
    return run(name, netlist, control)


def event_duration(name, threshold=0.05):
    """How long the TVS conducts more than `threshold` amps."""
    w = waveforms(name)
    above = w["time"][np.abs(w["i(vtvs)"]) > threshold]
    return float(above[-1] - above[0]) if len(above) > 1 else 0.0


def load_dump(ua, us, us_clamp, ri, td, tr=0.01):
    """ISO 16750-2 load dump on top of UA; Test B clamps the generator at Us* (central suppression)."""
    tau = td / math.log(10)
    expr = f"{ua} + ({us}-{ua}) * ((time/{tr}) * (1 - u(time-{tr})) + exp(-(time-{tr})/{tau}) * u(time-{tr}))"
    return f"min({expr}, {us_clamp})" if us_clamp else expr


def iso_pulse(ua, us, td, tr, t0=1e-4, battery_off=False):
    """ISO 7637-2 pulse 1 (battery disconnected, negative) or 2a (on top of UA)."""
    tau = td / math.log(10)
    pulse = f"{us} * (((time-{t0})/{tr}) * u(time-{t0}) * (1 - u(time-{t0}-{tr})) + exp(-(time-{t0}-{tr})/{tau}) * u(time-{t0}-{tr}))"
    base = f"{ua} * (1 - u(time-{t0}))" if battery_off else f"{ua}"
    return f"{base} + {pulse}"


def supply_scenarios(results):
    cases = [
        ("12 V system, suppressed load dump (Test B, 35 V)", "ld12b", load_dump(13.5, 101, 35, 0.5, 0.4), 0.5, 13.5, 0.6, 2e-5),
        ("24 V system, suppressed load dump (Test B, 58 V, Ri 1 ohm)", "ld24b", load_dump(27, 202, 58, 1, 0.35), 1, 27, 0.5, 2e-5),
        ("24 V system, suppressed load dump (Test B, 58 V, Ri 8 ohm)", "ld24b8", load_dump(27, 202, 58, 8, 0.35), 8, 27, 0.5, 2e-5),
        ("12 V system, unsuppressed load dump (Test A, 101 V)", "ld12a", load_dump(13.5, 101, None, 0.5, 0.4), 0.5, 13.5, 0.6, 2e-5),
        ("ISO 7637-2 pulse 1, 12 V (-150 V, 10 ohm, 2 ms)", "p1_12", iso_pulse(13.5, -150, 2e-3, 1e-6, battery_off=True), 10, 13.5, 6e-3, 1e-7),
        ("ISO 7637-2 pulse 1, 24 V (-600 V, 50 ohm, 1 ms)", "p1_24", iso_pulse(27, -600, 1e-3, 3e-6, battery_off=True), 50, 27, 4e-3, 1e-7),
        ("ISO 7637-2 pulse 2a, 12/24 V (+112 V, 2 ohm, 50 us)", "p2a", iso_pulse(27, 112, 50e-6, 1e-6), 2, 27, 4e-4, 2e-8),
        ("Reverse battery, -28 V", "rev28", "-28 * min(time/1m, 1)", 0.05, 0, 5e-3, 1e-6),
        ("Jump start / overvoltage, 36 V (24 V system)", "jump36", "36 * min(time/1m, 1)", 0.05, 0, 5e-3, 1e-6),
    ]
    for label, name, expr, ri, ua, tstop, tstep in cases:
        m = supply_case(name, expr, ri, ua, tstop, tstep)
        duration = event_duration(name)
        energy = abs(m.get("e_tvs", 0.0))
        rating = tvs_rating_j(duration) if duration else float("inf")
        vinp_peak = max(m.get("vinp_max", 0), 0)
        ok_tvs = energy < 0.5 * rating          # 50 % margin on the extrapolated rating
        ok_vin = vinp_peak < 60                 # TPS54360B: 60 V operating, 65 V absolute maximum; C1 63 V
        ok_rev = m.get("vinp_min", 0) > -0.7    # no reverse voltage reaches the converter
        verdict = "PASS" if ok_tvs and ok_vin and ok_rev else "FAIL"
        results.append((label, verdict,
                        f"TVS peak {max(abs(m.get('itvs_max', 0)), abs(m.get('itvs_min', 0))):.1f} A, "
                        f"{energy:.3g} J over {duration * 1e3:.3g} ms (survives about {rating:.2g} J); "
                        f"VIN_P {m.get('vinp_min', 0):.1f}..{vinp_peak:.1f} V"))


# --- +5V rail short (J804 pin 2 or J802 VCC on 5 V): PSU-B in current limit through D101 ----------------
def short_5v(results):
    netlist = """
* PSU-B output: 5.28 V behind the TPS54360B peak current limit (4.5 / 5.5 / 6.8 A min / typ / max)
VPSU psu 0 5.28
BLIM psu psu_l I = {ilim} * tanh((V(psu) - V(psu_l)) / 0.05)
RLIM psu psu_l 10k
VD101 psu_l d101a 0
D101 d101a v5 SS34
RSHORT v5 0 0.05
"""
    for ilim, tag in ((5.5, "typ"), (6.8, "max")):
        m = run(f"short5v_{tag}", netlist.format(ilim=ilim),
                "op\nlet p = (v(d101a) - v(v5)) * i(vd101)\nprint i(vd101) p\n")
        i = m.get("i(vd101)", ilim)
        p = m.get("p", 0.6 * ilim)
        tj = 25 + p * 90   # SS34 on SMA: about 90 C/W on minimum pads
        results.append((f"+5V shorted at J804/J802, PSU-B limit {tag} {ilim} A", "FAIL" if tj > 150 else "PASS",
                        f"D101 SS34 (3 A part) carries {i:.1f} A, {p:.1f} W -> about {tj:.0f} C junction; "
                        f"L1 (4.2 A saturation) is past saturation too"))


# --- Opto input (J301): ALT_RAW -> 3 x 1k -> M7 -> 4.7 V zener -> PC817 LED || 4.7k -> VEH_GND -----------
OPTO = """
R301 in r1 1k
R302 r1 r2 1k
R303 r2 alt_r 1k
VD301 alt_r d301a 0
D301 d301a alt_d M7
D302 alt_led alt_d DZ47
VLED alt_led led_a 0
DLED led_a 0 LED817
R304 alt_led 0 4.7k
* output: PC817C CTR >= 200 %, 22k pull-up to 3V3, saturates near 0.1 V
VCC vcc 0 3.3
R305 vcc out 22k
BCTR out 0 I = 2.0 * max(i(vled), 0) * (1 - exp(-V(out) / 0.1))
"""


def opto(results):
    m = run("opto_dc", "VIN in 0 0\n" + OPTO,
            "dc vin -60 60 0.05\nlet ir = i(vin) * -1\nlet pr = ir * ir * 1000\nlet pz = v(alt_d,alt_led) * i(vled)\n"
            "meas dc v_on when v(out)=0.825 fall=1\nmeas dc v_off when v(out)=2.475 fall=1\n"
            "wrdata DATA v(out) i(vled) pr pz\n")
    w = waveforms("opto_dc")
    at = lambda v, key: float(np.interp(v, w["v-sweep"] if "v-sweep" in w else w["time"], w[key]))
    x = "v-sweep" if "v-sweep" in w else "time"
    v_on, v_off = m.get("v_on"), m.get("v_off")
    results.append(("ALT/PULSE input threshold", "PASS" if v_on and 4 < v_on < 10 else "CHECK",
                    f"output reads LOW (< 0.825 V) above {v_on:.1f} V and stays HIGH (> 2.475 V) below {v_off:.1f} V; "
                    f"key-on L terminal (< 2 V) reads OFF"))
    for vin, label in ((36, "36 V (24 V system, high)"), (58, "58 V (24 V load dump on the input)"), (-60, "-60 V (reverse)")):
        ir = float(np.interp(vin, w[x], np.abs(w["pr"]) ** 0.5 / math.sqrt(1000)))
        pr = float(np.interp(vin, w[x], w["pr"]))
        ileds = float(np.interp(vin, w[x], w["i(vled)"]))
        pz = float(np.interp(vin, w[x], w["pz"]))
        ok = pr < 0.25 * (2.5 if vin == 58 else 1) and ileds < 0.05 and pz < 0.2
        results.append((f"ALT/PULSE input at {label}", "PASS" if ok else "FAIL",
                        f"{ir * 1e3:.1f} mA, each 1206 1k {pr * 1e3:.0f} mW (rated 250), LED {ileds * 1e3:.1f} mA (max 50), "
                        f"zener {pz * 1e3:.0f} mW (rated 200)"))
    # ISO 7637-2 pulses straight onto the input terminal
    for label, name, expr, ri in (("ALT/PULSE input, pulse 2a +112 V", "opto_p2a", iso_pulse(27, 112, 50e-6, 1e-6), 2),
                                  ("ALT/PULSE input, pulse 1 -600 V", "opto_p1", iso_pulse(27, -600, 1e-3, 3e-6, battery_off=True), 50)):
        m = run(name, f"BGEN gen 0 V = {expr}\nRI gen in {ri}\n" + OPTO,
                "tran 1e-7 4e-3\nlet vd = v(d301a) - v(alt_d)\nmeas tran iled_max max i(vled)\nmeas tran vd_min min vd\n"
                "meas tran in_max max v(in)\nmeas tran in_min min v(in)\n")
        ok = m.get("iled_max", 0) < 1.0 and m.get("vd_min", 0) > -1000
        results.append((label, "PASS" if ok else "FAIL",
                        f"LED peak {m.get('iled_max', 0) * 1e3:.0f} mA (1 A pulse rating), M7 reverse {abs(m.get('vd_min', 0)):.0f} V (1000 V)"))


# --- AIN1 (I/O variant, J902-2): C901 10 nF 1 kV -> 2 x 49.9k -> 10k || 100 nF, BAV99 to GND / +3V3 -> ADS1115 ---
AIN = """
C901 in 0 10n
R901 in mid 49.9k
R902 mid adc 49.9k
R903 adc 0 10k
C902 adc 0 100n
VDL 0 dla 0
DL dla adc BAV99
VDH adc dha 0
DH dha v33 BAV99
* +3V3 rail: the LDO does not sink, but the board's load (> 20 mA) takes the clamp current
V33 v33r 0 3.3
R33 v33r v33 1
"""


def ain(results):
    """Ratings: YAGEO RT1206 0.25 W, 200 V working / 400 V overload; ADS1115 input current 10 mA continuous,
    100 mA momentary (its own ESD diodes share the clamp current with the BAV99, so this is conservative)."""
    run("ain_dc", "VIN in 0 0\n" + AIN,
        "dc vin -60 60 0.05\nlet iclamp = i(vdh) - i(vdl)\nlet p901 = (v(in) - v(mid))^2 / 49.9k\n"
        "wrdata DATA v(adc) iclamp p901\n")
    w = waveforms("ain_dc")
    x = "v-sweep" if "v-sweep" in w else "time"
    at = lambda v, key: float(np.interp(v, w[x], w[key]))
    reading = at(30, "v(adc)")
    results.append(("AIN1 reading at 30 V", "PASS" if abs(reading - 30 * 10 / 109.8) < 0.01 else "FAIL",
                    f"ADC pin {reading:.3f} V (ideal {30 * 10 / 109.8:.3f} V; ADS1115 +/-4.096 V range, VDD 3.3 V)"))
    for vin, label in ((60, "+60 V"), (-60, "-60 V")):
        i, p, v = abs(at(vin, "iclamp")), at(vin, "p901"), at(vin, "v(adc)")
        ok = i < 10e-3 and p < 0.25 and -0.9 < v < 4.2
        results.append((f"AIN1 at {label} continuous", "PASS" if ok else "FAIL",
                        f"clamp {i * 1e3:.2f} mA (ADS1115 10 mA), each 49.9k {p * 1e3:.0f} mW (rated 250), ADC pin {v:.2f} V"))
    for label, name, expr, ri, tstop, tstep in (
            ("AIN1, 24 V unsuppressed load dump (Test A, 202 V, 350 ms)", "ain_ld24a", load_dump(27, 202, None, 1, 0.35), 1, 0.5, 2e-5),
            ("AIN1, ISO 7637-2 pulse 1 (-600 V, 50 ohm, 1 ms)", "ain_p1", iso_pulse(27, -600, 1e-3, 3e-6, battery_off=True), 50, 4e-3, 1e-7),
            ("AIN1, ISO 7637-2 pulse 2a (+112 V, 2 ohm, 50 us)", "ain_p2a", iso_pulse(27, 112, 50e-6, 1e-6), 2, 4e-4, 2e-8),
            ("AIN1, ISO 7637-2 pulse 3a (-220 V, 50 ohm, 150 ns)", "ain_p3a", iso_pulse(27, -220, 150e-9, 5e-9), 50, 2e-6, 1e-10),
            ("AIN1, ISO 7637-2 pulse 3b (+150 V, 50 ohm, 150 ns)", "ain_p3b", iso_pulse(27, 150, 150e-9, 5e-9), 50, 2e-6, 1e-10)):
        m = run(name, f"BGEN gen 0 V = {expr}\nRI gen in {ri}\n" + AIN,
                f"tran {tstep} {tstop}\nlet iclamp = i(vdh) - i(vdl)\nlet vr = v(in) - v(mid)\nlet p901 = vr^2 / 49.9k\n"
                f"meas tran ic_max max iclamp\nmeas tran ic_min min iclamp\nmeas tran vr_max max vr\nmeas tran vr_min min vr\n"
                f"meas tran vin_max max v(in)\nmeas tran vin_min min v(in)\nmeas tran e901 integ p901 from=0 to={tstop}\n"
                f"meas tran adc_max max v(adc)\nmeas tran adc_min min v(adc)\n")
        ic = max(abs(m.get("ic_max", 0)), abs(m.get("ic_min", 0)))
        vr = max(abs(m.get("vr_max", 0)), abs(m.get("vr_min", 0)))
        vc = max(abs(m.get("vin_max", 0)), abs(m.get("vin_min", 0)))
        ok = ic < 0.1 and vr < 400 and vc < 1000
        results.append((label, "PASS" if ok else "FAIL",
                        f"C901 {vc:.0f} V (1 kV), each 49.9k {vr:.0f} V peak (400 V overload) and {abs(m.get('e901', 0)) * 1e3:.2g} mJ, "
                        f"clamp {ic * 1e3:.1f} mA peak (100 mA momentary), ADC pin {m.get('adc_min', 0):.2f}..{m.get('adc_max', 0):.2f} V"))


# --- RS485 A/B miswired to the vehicle supply: PSM712 + SP3485 ------------------------------------------------
def rs485(results):
    netlist = """
VSRC src 0 0
RW src a 0.1
VTVS a tvs 0
DPa tvs_m tvs TVS712P
DPb tvs_m 0 TVS712N
* SP3485 bus input: about 12 k unit load
RIN a 0 12k
"""
    run("rs485_dc", netlist, "dc vsrc -30 30 0.05\nlet p = v(a) * i(vtvs)\nwrdata DATA i(vtvs) p v(a)\n")
    w = waveforms("rs485_dc")
    x = "v-sweep" if "v-sweep" in w else "time"
    for vin, label in ((14.4, "12 V system (14.4 V)"), (28.8, "24 V system (28.8 V)"), (-14.4, "reversed 12 V")):
        i = float(np.interp(vin, w[x], w["i(vtvs)"]))
        p = float(np.interp(vin, w[x], w["p"]))
        results.append((f"RS485 A or B wired to {label}", "FAIL" if abs(p) > 0.3 or abs(vin) > 12 else "PASS",
                        f"PSM712 {abs(i):.1f} A, {abs(p):.0f} W (SOT-23, about 0.3 W continuous); "
                        f"SP3485 bus pins are rated -7..+12 V"))


def short_5v_fused(results):
    """Compact board: J804 pin 2 and the GPS 5 V option go through 200 mA PTCs (F802 / F803, SMD1206P020TF).
    From its datasheet: trips in 80 ms at 8 A (I^2 t about constant), then holds about 0.6 W."""
    for ilim in (5.5, 6.8):
        t_trip = 8 ** 2 * 0.08 / ilim ** 2
        e_d101 = 0.6 * ilim * t_trip                  # SS34 at about 0.6 V
        i_held = 0.6 / 5.28
        results.append((f"Compact: +5V header shorted, F802/F803 fitted (PSU-B limit {ilim} A)", "PASS",
                        f"PTC trips in about {t_trip * 1e3:.0f} ms (D101 takes {e_d101:.2f} J), then holds {i_held * 1e3:.0f} mA (calculated)"))


def rs485_compact(results):
    """Compact board: THVD2410 (bus pins rated +/-70 V, 96 k input) with an SMAJ33CA from A and from B to GND;
    termination (J702, 120R across A-B) and bias (J703, 330R to 3V3 / GND) only when the jumpers are fitted."""
    for fitted in (False, True):
        jumpers = "R704 a b 120\nR705 a v33 330\nR706 b 0 330\nV33 v33 0 3.3\n" if fitted else "RB b 0 1e9\n"
        netlist = f"""
VSRC src 0 0
RW src a 0.1
VTA a ta 0
DAa ta_m ta TVS33
DAb ta_m 0 TVS33
VTB b tb 0
DBa tb_m tb TVS33
DBb tb_m 0 TVS33
RINA a 0 96k
RINB b 0 96k
{jumpers}
"""
        name = f"rs485c_{'jumpers' if fitted else 'bare'}"
        run(name, netlist, "dc vsrc -30 30 0.05\nwrdata DATA i(vta) i(vtb) v(a) v(b)\n")
        w = waveforms(name)
        x = "v-sweep" if "v-sweep" in w else "time"
        for vin, label in ((28.8, "24 V system (28.8 V)"), (-28.8, "reversed 24 V"), (14.4, "12 V system (14.4 V)")):
            i_tvs = abs(float(np.interp(vin, w[x], w["i(vta)"])))
            va, vb = (float(np.interp(vin, w[x], w[k])) for k in ("v(a)", "v(b)"))
            detail = f"A at {va:.1f} V (THVD2410 rated +/-70 V), SMAJ33CA {i_tvs * 1e6:.1f} uA"
            verdict = "PASS" if abs(va) < 70 and i_tvs < 1e-3 else "FAIL"
            if fitted:
                p704, p705, p706 = (va - vb) ** 2 / 120, (va - 3.3) ** 2 / 330, vb ** 2 / 330
                detail += f"; with J702/J703 fitted R704 {p704:.2f} W, R705 {p705:.2f} W, R706 {p706:.2f} W (0805/0603 parts burn open)"
                verdict = "PASS*" if verdict == "PASS" else verdict
            results.append((f"Compact: RS485 A wired to {label}{', jumpers fitted' if fitted else ''}", verdict, detail))


# --- UART / GPS port lines (J801, J802) wired to the vehicle supply: SRV05-4 to +5V ----------------------------
def port_lines(results):
    netlist = """
VSRC src 0 0
RW src line 0.1
* SRV05-4 channel: steering diode to its VCC pin (+5V rail) + 6.5 V rail clamp; the board loads +5V with ~0.2 A
VSD line sd 0
DS sd v5 SRVD
DSN 0 line SRVD
DZ 0 v5 SRVZ
VR5 v5r 0 5.0
DR5 v5r v5 SS34
RLOAD v5 0 25
"""
    run("port_dc", netlist, "dc vsrc 0 30 0.05\nlet p = (v(line) - v(v5)) * i(vsd) + v(v5) * (i(vsd) - v(v5)/25)\nwrdata DATA i(vsd) v(v5) p\n")
    w = waveforms("port_dc")
    x = "v-sweep" if "v-sweep" in w else "time"
    for vin, label in ((14.4, "12 V system"), (28.8, "24 V system")):
        i = float(np.interp(vin, w[x], w["i(vsd)"]))
        v5 = float(np.interp(vin, w[x], w["v(v5)"]))
        results.append((f"UART/GPS port line wired to {label} ({vin} V)", "FAIL",
                        f"SRV05-4 takes {i:.1f} A and lifts +5V to {v5:.1f} V (12 A for 20 us is its pulse rating)"))


# --- LM2596 boards (compact-lm2596, -io, microfit): F101 PTC -> VIN_RAW -> D103 SS54 -> VIN_LM -> D104, C102 -> LM2596S ---
SUPPLY_LM = """
VPTC gen_r ptc_a 0
* F101 1812L050/60GR (0.15 ohm minimum); its trip is worked out from i(vptc) afterwards
RPTC ptc_a vin_raw 0.25
VD103 vin_raw d103a 0
D103 d103a vin_lm {d103}
D102 vin_raw sense_d D4148
R101 sense_d sense 100k
R102 sense 0 5.6k
C101 sense 0 100n
VTVS {tvs_node} tvs_top 0
D104a tvs_mid tvs_top {tvs}
D104b tvs_mid 0 {tvs}
C102 vin_lm c102esr 220u
RC102 c102esr 0 0.1
C103 vin_lm 0 100n
* LM2596S + board as a constant-power load (about 1 W in), fading out below its 4.5 V minimum input
BLOAD vin_lm 0 I = 1.0 / max(V(vin_lm), 6) * 0.5 * (1 + tanh((V(vin_lm) - 4.5) / 0.3))
"""
PTC_TRIP_I2T = 8 ** 2 * 0.15   # F101: 150 ms maximum time to trip at 8 A, taken as a constant I^2 t (A^2 s); 60 V maximum
LM_BUILT = dict(d103="SS54", tvs_node="vin_lm", tvs="TVS30", ppk=400)
LM_BUILT_LO = dict(LM_BUILT, tvs="TVS30L")
# Proposed fix, PSU-B's order: the TVS (SMBJ36CA) on VIN_RAW ahead of a 100 V diode (SS510), so pulse 1 never reaches the diode
LM_FIX = dict(d103="SS510", tvs_node="vin_raw", tvs="TVS36", ppk=600)


def si(x, unit):
    return f"{x:.3g} {unit}" if abs(x) >= 1 else f"{x * 1e3:.0f} m{unit}"


def integral(y, t):
    return float(np.sum(np.diff(t) * (y[1:] + y[:-1]) / 2))


def lm2596_case(name, gen_expr, ri, tstop, tstep, stage):
    """One supply event. F101 opens once its I^2 t reaches PTC_TRIP_I2T (its slowest trip); the stresses are taken up to then."""
    run(name, f"BGEN gen 0 V = {gen_expr}\nRI gen gen_r {ri}\n" + SUPPLY_LM.format(**stage),
        f"tran {tstep} {tstop}\nwrdata DATA v(gen) v(vin_raw) v(vin_lm) v(sense) i(vtvs) i(vptc) i(vd103)\n")
    w = waveforms(name)
    t = w["time"]
    i2t = np.concatenate(([0.0], np.cumsum(np.diff(t) * w["i(vptc)"][1:] ** 2)))
    n = max(int(np.argmax(i2t > PTC_TRIP_I2T)), 2) if i2t[-1] > PTC_TRIP_I2T else len(t)
    after = w["v(gen)"][n:]
    t, w = t[:n], {k: v[:n] for k, v in w.items()}
    conducting = t[np.abs(w["i(vtvs)"]) > 0.05]
    i_rev = np.maximum(-w["i(vd103)"], 0)          # D103 conducting backwards: the SS54 in avalanche
    return {
        "trip": t[-1] if len(after) else None,
        "held": float(np.max(np.abs(after))) if len(after) else 0.0,
        "duration": float(conducting[-1] - conducting[0]) if len(conducting) > 1 else 0.0,
        "i_tvs": float(np.max(np.abs(w["i(vtvs)"]))),
        "e_tvs": integral(np.abs(w[f"v({stage['tvs_node']})"] * w["i(vtvs)"]), t),
        "vin_max": float(np.max(w["v(vin_lm)"])),
        "vin_min": float(np.min(w["v(vin_lm)"])),
        "i_av": float(np.max(i_rev)),
        "e_av": integral((w["v(vin_lm)"] - w["v(vin_raw)"]) * i_rev, t),
    }


def lm2596_scenarios(results):
    ld12, p1_12, p1_24 = load_dump(13.5, 101, 35, 0.5, 0.4), iso_pulse(13.5, -150, 2e-3, 1e-6, battery_off=True), \
        iso_pulse(27, -600, 1e-3, 3e-6, battery_off=True)
    cases = [
        ("12 V system, clamped load dump (Test B, 35 V), typical SMAJ30CA", "lm_ld12b", ld12, 0.5, 0.6, 2e-5, LM_BUILT),
        ("12 V system, clamped load dump (Test B, 35 V), lowest-breakdown SMAJ30CA", "lm_ld12b_lo", ld12, 0.5, 0.6, 2e-5, LM_BUILT_LO),
        ("24 V system, clamped load dump (Test B, 58 V, Ri 1 ohm)", "lm_ld24b", load_dump(27, 202, 58, 1, 0.35), 1, 0.5, 2e-5, LM_BUILT),
        ("24 V system, clamped load dump (Test B, 58 V, Ri 8 ohm)", "lm_ld24b8", load_dump(27, 202, 58, 8, 0.35), 8, 0.5, 2e-5, LM_BUILT),
        ("ISO 7637-2 pulse 1, 12 V (-150 V, 10 ohm, 2 ms)", "lm_p1_12", p1_12, 10, 6e-3, 1e-7, LM_BUILT),
        ("ISO 7637-2 pulse 1, 24 V (-600 V, 50 ohm, 1 ms)", "lm_p1_24", p1_24, 50, 4e-3, 1e-7, LM_BUILT),
        ("ISO 7637-2 pulse 2a, 12/24 V (+112 V, 2 ohm, 50 us)", "lm_p2a", iso_pulse(27, 112, 50e-6, 1e-6), 2, 4e-4, 2e-8, LM_BUILT),
        ("Reverse battery, -28 V", "lm_rev28", "-28 * min(time/1m, 1)", 0.05, 5e-3, 1e-6, LM_BUILT),
        ("proposed fix, 12 V clamped load dump (Test B, 35 V)", "lmfix_ld12b", ld12, 0.5, 0.6, 2e-5, LM_FIX),
        ("proposed fix, ISO 7637-2 pulse 1, 12 V (-150 V, 10 ohm, 2 ms)", "lmfix_p1_12", p1_12, 10, 6e-3, 1e-7, LM_FIX),
        ("proposed fix, ISO 7637-2 pulse 1, 24 V (-600 V, 50 ohm, 1 ms)", "lmfix_p1_24", p1_24, 50, 4e-3, 1e-7, LM_FIX),
    ]
    for label, name, expr, ri, tstop, tstep, stage in cases:
        s = lm2596_case(name, expr, ri, tstop, tstep, stage)
        rating = tvs_rating_j(s["duration"], ppk=stage["ppk"]) if s["duration"] else float("inf")
        ok_tvs = s["e_tvs"] < 0.5 * rating               # 50 % margin on the extrapolated rating
        ok_vin = -0.3 < s["vin_min"] and s["vin_max"] < 45  # LM2596S: 40 V operating, 45 V absolute maximum
        ok_ptc = s["held"] < 60                            # F101 holds the rest of the event once it has tripped
        verdict = "PASS" if ok_tvs and ok_vin and ok_ptc else "FAIL"
        if verdict == "PASS" and s["e_av"] > 1e-3:
            verdict = "CHECK"                              # the SS54 has no avalanche rating
        trip = f"F101 trips after {s['trip'] * 1e3:.0f} ms and holds {s['held']:.0f} V (rated 60 V); " if s["trip"] else ""
        tvs = (f"TVS peak {s['i_tvs']:.1f} A, {s['e_tvs']:.3g} J over {s['duration'] * 1e3:.3g} ms (survives about {rating:.2g} J)"
               if s["duration"] else "TVS off")
        diode = (f"{stage['d103']} driven backwards: {s['i_av']:.1f} A peak, {s['e_av'] * 1e3:.0f} mJ of avalanche (not rated)"
                 if s["e_av"] > 1e-3 else f"{stage['d103']} blocks")
        vmin, vmax = (0.0 if abs(v) < 0.05 else v for v in (s["vin_min"], s["vin_max"]))
        results.append((f"LM2596 boards: {label}", verdict, f"{trip}{tvs}; VIN_LM {vmin:.1f}..{vmax:.1f} V; {diode}"))


def lm2596_dc(results):
    """Steady overvoltage on the LM2596 boards: the SMAJ30CA's leakage and conduction, and the VIN_SENSE divider (GPIO34)."""
    for tvs, part in (("TVS30", "typical SMAJ30CA"), ("TVS30L", "lowest-breakdown SMAJ30CA")):
        name = f"lm_dc_{tvs.lower()}"
        run(name, "VSRC gen 0 0\nRI gen gen_r 0.05\n" + SUPPLY_LM.format(**dict(LM_BUILT, tvs=tvs)),
            "dc vsrc 0 40 0.05\nlet p_tvs = v(vin_lm) * i(vtvs)\nwrdata DATA i(vtvs) p_tvs v(sense) v(vin_lm)\n")
        w = waveforms(name)
        x = "v-sweep" if "v-sweep" in w else "time"
        for vin, label in ((24, "12 V jump start (24 V)"), (28.8, "24 V system charging (28.8 V)"), (32, "24 V system maximum (32 V)"),
                           (36, "24 V jump start (36 V)")):
            i, p = (abs(float(np.interp(vin, w[x], w[k]))) for k in ("i(vtvs)", "p_tvs"))
            vlm = float(np.interp(vin, w[x], w["v(vin_lm)"]))
            tvs_state = (f"TVS takes {i * 1e3:.0f} mA, {p:.2g} W steady (an SMA part sheds about 1 W; F101, 0.5 A hold and 1 A trip, "
                         f"does not stop it)") if i > 1e-4 else "TVS off (leakage only)"
            results.append((f"LM2596 boards: {label}, {part}", "PASS" if p < 0.5 else "FAIL",
                            f"{tvs_state}; VIN_LM {vlm:.1f} V (LM2596S: 40 V)"))
    sense = ", ".join(f"{v:g} V -> {float(np.interp(v, w[x], w['v(sense)'])):.2f} V" for v in (9, 14.4, 28.8, 36))
    results.append(("VIN_SENSE divider (D102, 100k / 5.6k) to GPIO34", "PASS", f"{sense}; 58 V (load dump) -> "
                    f"{(58 - 0.6) * 5.6 / 105.6:.2f} V, under the ESP32's 3.6 V maximum"))


# --- Micro-Fit board, J1: pin 11 (+5 V out) and pin 3 (UART TX) next to vehicle-voltage pins ---------------------------
RAIL5V = """
* +5V: LM2596 output (5.29 V) through D101 SS34; C205 10 uF; SRV05-4 rail clamp (VP-VN). The AMS1117 draws about 50 mA,
* the board's lightest load with the ESP32 awake: the less the board draws, the further a back-feed lifts +5V
VPSU psu 0 5.29
D101 psu v5 SS34
C205 v5 0 10u
BBOARD v5 0 I = 0.05 * tanh(V(v5) / 0.5)
VZ v5 vz 0
DZ 0 vz SRVZ
* J1 pin 11: F801 SMD1206P020TF, 0.35-0.9 ohm before it trips
VF801 v5 f801a 0
RF801 f801a pin11 0.6
* J1 pin 3: R801 100R from GPIO17 (UART2 TX, idle high), SRV05-4 IO1 steering diodes to +5V and GND
VSD pin3 sd 0
DS sd v5 SRVD
DSN 0 pin3 SRVD
R801 pin3 gpio 100
* ESP32 GPIO17 driving high: 3.3 V behind about 33 ohm (default drive strength)
VG gpio_s 0 3.3
VGPIO gpio_s gpio_o 0
ROUT gpio_o gpio 33
"""
F801_I2T = 8 ** 2 * 0.08     # SMD1206P020TF: 80 ms maximum time to trip at 8 A (A^2 s); trips above 0.46 A; 24 V, 10 A maximum


def microfit_pins(results):
    """DOUT1 (pin 10) is open drain: while it is off, its load (a relay coil or a lamp) pulls it up to the supply.
    Pin 10 sits beside pin 11 (+5 V out) and across from pin 3 (UART TX)."""
    cases = [
        ("J1-11 (+5 V out) wired to 14.4 V", "mf_p11_14", "VSRC src 0 14.4\nRW src pin11 0.1\n", 14.4),
        ("J1-11 (+5 V out) wired to 28.8 V", "mf_p11_28", "VSRC src 0 28.8\nRW src pin11 0.1\n", 28.8),
        ("J1-10/11 shorted, DOUT1 off, 12 V relay coil (85 ohm)", "mf_d11_12", "VSRC src 0 14.4\nRL src pin11 85\n", 14.4),
        ("J1-10/11 shorted, DOUT1 off, 24 V relay coil (280 ohm)", "mf_d11_24", "VSRC src 0 28.8\nRL src pin11 280\n", 28.8),
        ("J1-10/11 shorted, DOUT1 off, 0.5 A load on 24 V (58 ohm)", "mf_d11_05", "VSRC src 0 28.8\nRL src pin11 58\n", 28.8),
        ("J1-3/10 shorted, DOUT1 off, 24 V relay coil (280 ohm)", "mf_d3_24", "VSRC src 0 28.8\nRL src pin3 280\n", 28.8),
        ("J1-3/10 shorted, DOUT1 off, 0.5 A load on 24 V (58 ohm)", "mf_d3_05", "VSRC src 0 28.8\nRL src pin3 58\n", 28.8),
        ("J1-3 (UART TX) shorted to J1-2 (GND)", "mf_p3_gnd", "RSH pin3 0 0.01\n", 0),
    ]
    for label, name, fault, vsrc in cases:
        m = run(name, RAIL5V + fault, "op\nprint v(v5) v(pin3) v(gpio) i(vf801) i(vz) i(vsd) i(vgpio)\n")
        v5, i_f801, i_gpio = m.get("v(v5)", 0), -m.get("i(vf801)", 0), -m.get("i(vgpio)", 0)
        p_srv = v5 * m.get("i(vz)", 0) + (m.get("v(pin3)", 0) - v5) * m.get("i(vsd)", 0)
        problems = []
        if v5 > 7:
            problems.append("+5V above the SN74AHCT1G125's 7 V absolute maximum")
        if p_srv > 0.3:
            problems.append("SRV05-4 over about 0.3 W (SOT-23-6)")
        if m.get("v(gpio)", 0) > 3.6:
            problems.append("GPIO17 above the ESP32's VDD + 0.3 V")
        detail = f"+5V at {v5:.2f} V{' (SN74AHCT1G125: 5.5 V operating, 7 V absolute)' if 5.5 < v5 <= 7 else ''}, SRV05-4 {si(p_srv, 'W')}"
        if "pin11" in fault:
            detail += f", F801 {si(i_f801, 'A')}"
            if i_f801 > 0.46:
                t_trip = F801_I2T / i_f801 ** 2
                detail += (f" (rated 10 A): it trips within {t_trip * 1e3:.0f} ms, the SRV05-4 taking about {p_srv * t_trip:.2g} J, "
                           f"then holds {vsrc - 5:.1f} V (rated 24 V)")
            else:
                detail += " (trips above 0.46 A, so it stays closed)"
        if "pin3" in fault:
            detail += f", GPIO17 {'takes' if i_gpio > 0 else 'drives'} {abs(i_gpio) * 1e3:.1f} mA at {m.get('v(gpio)', 0):.2f} V"
        verdict = "FAIL" if problems else "PASS*" if v5 > 5.5 else "PASS"
        results.append((f"Micro-Fit: {label}", verdict, detail + (": " + "; ".join(problems) if problems else "")))
    lo, hi = 0.7, 1.5   # BSP75N current limit
    results.append(("Micro-Fit: J1-10/11 shorted, DOUT1 on", "PASS",
                    f"the BSP75N limits at {lo}-{hi} A from +5V; F801 trips within {F801_I2T / hi ** 2:.1f}-{F801_I2T / lo ** 2:.0f} s "
                    f"and the LM2596 (3 A) carries it meanwhile (calculated)"))
    results.append(("Micro-Fit: J1-11 (+5 V out) shorted to GND", "PASS",
                    f"the LM2596 limits at 3.6-6.9 A; F801 trips within {F801_I2T / 6.9 ** 2 * 1e3:.0f}-{F801_I2T / 3.6 ** 2 * 1e3:.0f} ms "
                    f"while +5V sags (the ESP32 may reset), then holds about {0.6 / 5.0 * 1e3:.0f} mA (calculated)"))
    results.append(("Micro-Fit: J1-9 (AIN1) wired to 28.8 V with the 4-20 mA shunt R904 fitted", "FAIL",
                    f"R904 (120R 1206, 0.25 W) takes {28.8 ** 2 / 120:.1f} W (calculated); without R904, AIN1 survives +/-60 V"))


LED_DRIVE = """
VG gpio 0 3.3
RO gpio o 33
R8 o a 330
VLED a ak 0
DLED ak 0 {model}
"""


def leds(results):
    """Micro-Fit D801-D803: GPIO18/19/5 (3.3 V behind about 33 ohm) -> 330R (R808-R810) -> side-view LED -> GND."""
    for label, model, mcd in (("D801-D803, green LTST-S270TGKT (VF 3.2 V)", "LEDG", 450),
                              ("D801-D803, a green part with 2.8 V VF", "LEDGLO", 450),
                              ("D801-D803, a green part with 3.8 V VF", "LEDGHI", 450)):
        m = run(f"led_{model.lower()}", LED_DRIVE.format(model=model), "op\nprint i(vled) v(a)\n")
        i = m.get("i(vled)", 0)
        results.append((f"LED drive: {label}", "PASS" if 0.5e-3 < i < 20e-3 else "CHECK",
                        f"{i * 1e3:.2f} mA at {m.get('v(a)', 0):.2f} V; about {mcd * i / 20e-3:.0f} mcd ({mcd} mcd at 20 mA, scaled by current)"))


def plot(results):
    os.makedirs(PLOTS, exist_ok=True)
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.8))
    for name, label, ax in (("ld12b", "12 V system, Test B (35 V)", axes[0]), ("ld24b", "24 V system, Test B (58 V, Ri 1 ohm)", axes[1])):
        w = waveforms(name)
        t = w["time"] * 1e3
        ax.plot(t, w["v(gen)"], color="#999", lw=1, label="generator (open circuit)")
        ax.plot(t, w["v(vin_raw)"], color="#1f6feb", lw=1.5, label="VIN_RAW (PSU-B input)")
        ax2 = ax.twinx()
        ax2.plot(t, w["i(vtvs)"], color="#d1242f", lw=1.2, label="SMBJ36CA current")
        ax.set_title(label, fontsize=10)
        ax.set_xlabel("ms")
        ax.set_ylabel("V")
        ax2.set_ylabel("A", color="#d1242f")
        ax.legend(loc="upper right", fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(PLOTS, "load-dump.png"), dpi=110)

    w = waveforms("opto_dc")
    x = w["v-sweep"] if "v-sweep" in w else w["time"]
    fig, ax = plt.subplots(figsize=(6.5, 3.6))
    ax.plot(x, w["v(out)"], color="#1f6feb", label="ALT_IN_N (to GPIO27)")
    ax.axhline(0.825, color="#999", ls=":", lw=1)
    ax.axhline(2.475, color="#999", ls=":", lw=1)
    ax2 = ax.twinx()
    ax2.plot(x, w["i(vled)"] * 1e3, color="#d1242f", label="PC817 LED current")
    ax.set_xlabel("J301 input (V)")
    ax.set_ylabel("output (V)")
    ax2.set_ylabel("LED mA", color="#d1242f")
    ax.set_title("Vehicle input: transfer and LED current", fontsize=10)
    fig.tight_layout()
    fig.savefig(os.path.join(PLOTS, "opto-input.png"), dpi=110)

    # LM2596 boards, 12 V pulse 1: voltages on top, the reverse-polarity diode's current below (one scale per panel)
    fig, axes = plt.subplots(2, 2, figsize=(11, 5.6), sharex=True, sharey="row", gridspec_kw={"height_ratios": [3, 2]})
    for col, (name, title, diode) in enumerate((("lm_p1_12", "As built: SMAJ30CA behind D103 (SS54, 40 V)", "SS54"),
                                                ("lmfix_p1_12", "Proposed: SMBJ36CA ahead of D103 (SS510, 100 V)", "SS510"))):
        w = waveforms(name)
        t = (w["time"] - 1e-4) * 1e3
        top, bottom = axes[0][col], axes[1][col]
        top.plot(t, w["v(gen)"], color="#999", lw=1, label="generator (open circuit)")
        top.plot(t, w["v(vin_raw)"], color="#d1242f", lw=1.5, label="VIN_RAW (after F101)")
        top.plot(t, w["v(vin_lm)"], color="#1f6feb", lw=1.5, label="VIN_LM (LM2596S input)")
        top.axhline(0, color="#ccc", lw=0.8)
        top.set_ylim(-160, 30)
        top.set_title(title, fontsize=10)
        bottom.plot(t, w["i(vd103)"], color="#1f6feb", lw=1.5, label=f"D103 {diode} current (negative: backwards)")
        bottom.axhline(0, color="#ccc", lw=0.8)
        bottom.set_xlabel("ms after the pulse starts")
        top.legend(loc="lower right", fontsize=7)
        bottom.legend(loc="lower right", fontsize=7)
    axes[0][0].set_ylabel("V")
    axes[1][0].set_ylabel("A")
    fig.suptitle("ISO 7637-2 pulse 1 on a 12 V supply (-150 V, 10 ohm, 2 ms), LM2596 input stage", fontsize=10)
    fig.tight_layout()
    fig.savefig(os.path.join(PLOTS, "lm2596-pulse1.png"), dpi=110)


def main():
    results = []
    supply_scenarios(results)
    short_5v(results)
    short_5v_fused(results)
    opto(results)
    ain(results)
    rs485(results)
    rs485_compact(results)
    port_lines(results)
    lm2596_scenarios(results)
    lm2596_dc(results)
    microfit_pins(results)
    leds(results)
    plot(results)
    width = max(len(r[0]) for r in results)
    for label, verdict, detail in results:
        print(f"{verdict:5} {label:<{width}}  {detail}")


if __name__ == "__main__":
    main()
