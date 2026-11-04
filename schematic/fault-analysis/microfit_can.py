#!/usr/bin/env python3
"""Simulations for the main board, Micro-Fit + CAN + RS232 (../hour-meter-board), with ngspice.

  python3 microfit_can.py      -> runs every scenario, prints the results, writes plots/can-*.png and plots/rs232-*.png

It covers what that board adds or changes; the circuits it shares with the Micro-Fit board keep their results
in faults.py. Each deck is built from the parts on the board's schematics and reuses faults.py's ngspice
runner and models. Behavioural models (CAN and RS232 drivers, receivers) are fitted to the datasheet figures
named next to them: good for levels, timing margins and fault stresses, not for exact edge shapes.
"""
import os

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

import faults

PLOTS = faults.PLOTS

# SZNUP3105L (D701 on RS485, D1001 on CAN): per line two zeners back to back to GND. VBR 35.6 V minimum at 1 mA
# (37 V taken as typical), VC 59 V at 5 A and 66 V at 8 A (8/20 us): Rs about 3.5 ohm; 30 pF per line maximum,
# so 60 pF per diode (two in series). onsemi NUP3105L/D rev. 5.
faults.MODELS += """
.model NUP3105 D(Is=1e-12 N=1 Rs=3.5 BV=37 IBV=1m Cjo=60p)
.model NUP3105L D(Is=1e-12 N=1 Rs=3.5 BV=35.6 IBV=1m Cjo=60p)
.model DOR D(Is=1e-6 N=1.05 Rs=0.05)
"""
run, waveforms = faults.run, faults.waveforms

# Plot styling: the reference palette's first three categorical slots on a light surface; thresholds in muted ink
BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
INK, MUTED, SURFACE, GRID = "#0b0b0b", "#52514e", "#fcfcfb", "#e4e3df"


# --- CAN physical layer: bus timing with the board on a stub ------------------------------------------------------
# TJA1051T/3 driver: dominant CANH about 3.5 V and CANL about 1.5 V into 60 ohm (VO(dif) 1.5-3 V, typical 2 V);
# recessive: driver off, both lines at VCC/2 through the 9-28 kohm input bias (25 k taken). Modelled per line as
# 4.0 V / 1.0 V behind 15 ohm, switched in 30 ns. Receiver: dominant above 0.9 V, recessive below 0.5 V differential.
# Cable: a twisted pair as two 60 ohm lines (the odd mode of a 120 ohm pair), 5 ns/m. The board node: SZNUP3105L
# (30 pF per line), TJA1051 inputs (20 pF common mode, 25 k bias). J1939 backbone: 2 x 10 m with 120 ohm at each end.
BITS = "011010011110"   # CAN bit levels, 0 = dominant: SOF, single bits and a run of 4


def bit_source(name, bit_time, edge=40e-9):
    """PWL source V(name) = 1 while dominant, 0 while recessive, for BITS at bit_time."""
    pts, level = ["0 0"], 0.0
    t = 0.5e-6
    for b in BITS:
        new = 1.0 if b == "0" else 0.0
        if new != level:
            pts.append(f"{t:.5e} {level}")
            pts.append(f"{t + edge:.5e} {new}")
            level = new
        t += bit_time
    pts.append(f"{t + bit_time:.5e} {level}")
    return f"V{name} {name} 0 PWL({' '.join(pts)})\n", t


def can_node(tag, h, l, tvs=True, driver=None, termination=False):
    """One CAN node: bias, input capacitance, optional SZNUP3105L, optional driver and 120 ohm termination."""
    s = (f"RB{tag}h {h} vmid 25k\nRB{tag}l {l} vmid 25k\nCI{tag}h {h} 0 20p\nCI{tag}l {l} 0 20p\n")
    if tvs:
        s += (f"DT{tag}ha m{tag}h {h} NUP3105\nDT{tag}hb m{tag}h 0 NUP3105\n"
              f"DT{tag}la m{tag}l {l} NUP3105\nDT{tag}lb m{tag}l 0 NUP3105\n")
    if driver:
        s += (f"BD{tag}h 0 {h} I = V({driver}) / 15 * (4.0 - V({h}))\n"
              f"BD{tag}l 0 {l} I = V({driver}) / 15 * (1.0 - V({l}))\n")
    if termination:
        s += f"RT{tag} {h} {l} 120\n"
    return s


def stub_ladder(stub_m):
    """The stub from the backbone to the board as an LC ladder, one section per metre (300 nH and 83 pF per metre
    per line: 60 ohm, 5 ns/m). A 1-3 m stub is short against the 30-50 ns edges, and a lossless line this short
    would force ngspice into picosecond steps."""
    n = max(1, round(stub_m))
    l, c = 300e-9 * stub_m / n, 83e-12 * stub_m / n
    s, prev = "", ("jh", "jl")
    for i in range(n):
        nxt = ("bdh", "bdl") if i == n - 1 else (f"sh{i}", f"sl{i}")
        for k in (0, 1):
            s += f"LS{k}_{i} {prev[k]} {nxt[k]} {l:.4e}\nCS{k}_{i} {nxt[k]} 0 {c:.4e}\n"
        prev = nxt
    return s


def can_bus(name, bit_time, stub_m, board_drives=False, board_term=False, board_tvs=True):
    """ECU at one backbone end (or the board) sends BITS; returns the differential waveform at the receiver."""
    src, t_end = bit_source("dom", bit_time)
    netlist = src + "VMID vmid 0 2.5\n"
    netlist += can_node("e1", "e1h", "e1l", tvs=False, driver=None if board_drives else "dom", termination=True)
    netlist += can_node("e2", "e2h", "e2l", tvs=False, termination=True)
    netlist += can_node("bd", "bdh", "bdl", tvs=board_tvs, driver="dom" if board_drives else None,
                        termination=board_term)
    netlist += ("T1h e1h 0 jh 0 Z0=60 TD=50n\nT1l e1l 0 jl 0 Z0=60 TD=50n\n"
                "T2h jh 0 e2h 0 Z0=60 TD=50n\nT2l jl 0 e2l 0 Z0=60 TD=50n\n"
                + stub_ladder(stub_m))
    rx = ("e1h", "e1l") if board_drives else ("bdh", "bdl")
    run(name, netlist, f"tran 2n {t_end:.4e}\nwrdata DATA v({rx[0]}) v({rx[1]}) v(dom)\n")
    w = waveforms(name)
    return w["time"], w[f"v({rx[0]})"] - w[f"v({rx[1]})"], w["v(dom)"]


def can_margins(t, vd, dom, bit_time, sample=0.875):
    """Worst dominant and recessive differential voltage at each bit's sample point (bits timed from the receiver's
    own first edge, as a CAN controller resynchronises on edges), and the longest settling after an edge."""
    first_tx = t[np.argmax(dom > 0.5)]
    first_rx = t[np.argmax(vd > 0.7)]
    delay = first_rx - first_tx
    worst_dom, worst_rec = np.inf, -np.inf
    start = 0.5e-6
    for k, b in enumerate(BITS):
        ts = start + delay + (k + sample) * bit_time
        v = float(np.interp(ts, t, vd))
        if b == "0":
            worst_dom = min(worst_dom, v)
        else:
            worst_rec = max(worst_rec, v)
    # settling: time from each transition until the differential stays inside 10 % of 2 V of its final value
    settle = 0.0
    for k in range(1, len(BITS)):
        if BITS[k] == BITS[k - 1]:
            continue
        t0, t1 = start + delay + k * bit_time, start + delay + (k + 1) * bit_time
        sel = (t >= t0) & (t < t1)
        final = vd[sel][-1]
        outside = np.where(np.abs(vd[sel] - final) > 0.2)[0]
        if len(outside):
            settle = max(settle, t[sel][outside[-1]] - t0)
    return worst_dom, worst_rec, delay, settle


CAN_CASES = (
    # name, bit rate, stub (m), board drives, JP1001 bridged, TVS fitted, what it shows
    ("can250", 250e3, 1.0, False, False, True, "J1939 at 250 kbit/s, board on a 1 m stub, receiving"),
    ("can500", 500e3, 1.0, False, False, True, "OBD-II / J1939 at 500 kbit/s, board on a 1 m stub, receiving"),
    ("can500_tx", 500e3, 1.0, True, False, True, "500 kbit/s, the board sending (an OBD-II request), ECU receiving"),
    ("can500_3m", 500e3, 3.0, False, False, True, "500 kbit/s on a 3 m stub (long OBD-II Y-cable)"),
    ("can500_term", 500e3, 1.0, False, True, True, "500 kbit/s, JP1001 bridged by mistake on a stub node"),
    ("can500_notvs", 500e3, 1.0, False, False, False, "500 kbit/s without D1001 (to see what its 30 pF costs)"),
)


def can_signal(results, curves):
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(len(CAN_CASES)) as pool:   # each ngspice run takes a few minutes; run them side by side
        runs = list(pool.map(lambda c: can_bus(c[0], 1 / c[1], c[2], board_drives=c[3], board_term=c[4], board_tvs=c[5]),
                             CAN_CASES))
    for (name, rate, stub, drives, term, tvs, what), (t, vd, dom) in zip(CAN_CASES, runs):
        worst_dom, worst_rec, delay, settle = can_margins(t, vd, dom, 1 / rate)
        ok = worst_dom > 0.9 and worst_rec < 0.5
        detail = (f"dominant >= {worst_dom:.2f} V and recessive <= {worst_rec:.2f} V at the 87.5 % sample point "
                  f"(receiver: > 0.9 V / < 0.5 V); settles in {settle * 1e9:.0f} ns of a {1e9 / rate:.0f} ns bit; "
                  f"propagation {delay * 1e9:.0f} ns")
        results.append((f"CAN: {what}", "PASS" if ok else "FAIL", detail))
        curves[name] = (t, vd)


# --- CAN and RS485 lines wired to the vehicle supply -----------------------------------------------------------------
def bus_faults(results):
    """A CAN or RS485 line forced to a supply voltage (DC). The rest of the bus: 60 ohm (two 120 ohm terminations)
    to the other line, which the other transceivers hold at the bus midpoint through their bias. Board: SZNUP3105L
    (lowest breakdown, 35.6 V) per line, transceiver inputs (TJA1051 25 k to 2.5 V; THVD2410 96 k to GND)."""
    for bus, mid, rin, rating, term_part in (("CAN", 2.5, 25e3, 58, "R1001 (JP1001)"), ("RS485", 1.65, 96e3, 70, "R704 (JP702)")):
        for bridged in (False, True):
            netlist = f"""
VF f 0 0
RW f h 0.1
VTH h th 0
DHa mh th NUP3105L
DHb mh 0 NUP3105L
VTL l tl 0
DLa ml tl NUP3105L
DLb ml 0 NUP3105L
RIH h vb {rin:g}
RIL l vb {rin:g}
VB vb 0 {mid if bus == "CAN" else 0}
RBUS h l 60
RBIAS l vm 1k
VM vm 0 {mid}
{"RTERM h l 120" if bridged else ""}
"""
            name = f"{bus.lower()}_fault{'_term' if bridged else ''}"
            run(name, netlist, "dc vf -40 40 0.05\nwrdata DATA i(vth) i(vtl) v(h) v(l) i(vf)\n")
            w = waveforms(name)
            x = "v-sweep" if "v-sweep" in w else "time"
            for v, label in ((14.4, "a 12 V system (14.4 V)"), (28.8, "a 24 V system (28.8 V)"),
                             (36.0, "a 24 V jump start (36 V)"), (40.0, "40 V"), (-28.8, "a reversed 24 V supply")):
                if bridged and v != 28.8:
                    continue
                vh, vl = (float(np.interp(v, w[x], w[k])) for k in ("v(h)", "v(l)"))
                i_tvs = max(abs(float(np.interp(v, w[x], w[k]))) for k in ("i(vth)", "i(vtl)"))
                line = "CAN_H" if bus == "CAN" else "A"
                detail = f"{line} at {vh:.1f} V, other line at {vl:.1f} V (transceiver rated +/-{rating} V); SZNUP3105L {i_tvs * 1e3:.2f} mA"
                if i_tvs > 1e-3:
                    verdict = "FAIL"
                    detail += (f" - from a stiff supply it conducts {i_tvs:.1f} A and burns; the lowest-breakdown part starts"
                               f" at 35.6 V, so about 36 V is the line's DC limit (the old SMAJ33CA: 36.7 V)")
                else:
                    verdict = "PASS" if abs(vh) < rating else "FAIL"
                if bridged:
                    p = (vh - vl) ** 2 / 120
                    detail += f"; {term_part} {p * 1e3:.0f} mW (the bus terminations hold both lines together, so it stays cool)"
                results.append((f"{bus}: {line} wired to {label}{', terminator bridged' if bridged else ''}", verdict, detail))
    # both lines of a pair shorted to opposite rails with the terminator bridged: the worst case for the resistor
    for bus, part, rating_w in (("CAN", "R1001 (0805, 0.125 W)", 0.125), ("RS485", "R704 (0805, 0.125 W)", 0.125)):
        p = 28.8 ** 2 / 120
        results.append((f"{bus}: one line on 28.8 V and the other on GND, terminator bridged", "PASS*",
                        f"{part} takes {p:.1f} W and burns open; the transceiver and protector survive (calculated)"))


# --- RS232: MAX13223E levels and faults --------------------------------------------------------------------------------
# Driver: about +/-6 V into 3 k (+/-5 V minimum), 300 ohm output resistance when off, +/-80 mA short-circuit
# current, slew limited (250 kbit/s into 3 k + 1 nF): modelled as +/-6.4 V behind 50 ohm with 0.5 us edges.
# Receiver input 3-7 k (5 k typical); thresholds 0.6 V (low) / 2.4 V (high) at 3.3 V. Cable: up to 2500 pF (EIA-232).
def rs232_signal(results, curves):
    for rate, cable_pf, load in ((115200, 2500, 3e3), (250e3, 1000, 3e3), (115200, 2500, 7e3)):
        bit = 1 / rate
        pattern = "1011001110001010"   # UART line bits (1 = mark = negative on the RS232 line)
        pts, level, t = ["0 -6.4"], -6.4, 2e-6
        pts.append(f"{t:.4e} -6.4")
        for b in pattern:
            new = -6.4 if b == "1" else 6.4
            if new != level:
                pts.append(f"{t:.4e} {level}")
                pts.append(f"{t + 0.5e-6:.4e} {new}")
                level = new
            t += bit
        netlist = (f"VD d 0 PWL({' '.join(pts)} {t:.4e} {level})\nRO d tx 50\nCC tx 0 {cable_pf}p\n"
                   f"RC tx rx 2\nRL rx 0 {load:g}\n")
        name = f"rs232_{int(rate / 1000)}k_{int(load / 1000)}k"
        run(name, netlist, f"tran 20n {t:.4e}\nwrdata DATA v(rx) v(d)\n")
        w = waveforms(name)
        tt, v = w["time"], w["v(rx)"]
        lows, highs = [], []
        for k, b in enumerate(pattern):
            vs = float(np.interp(2e-6 + (k + 0.5) * bit, tt, v))
            (lows if b == "1" else highs).append(vs)
        ok = min(highs) > 3.0 and max(lows) < -3.0
        results.append((f"RS232: {rate / 1000:.1f} kbit/s into {load / 1000:.0f} k + {cable_pf} pF", "PASS" if ok else "FAIL",
                        f"line at bit centre between {min(highs):+.2f} V and {max(lows):+.2f} V (EIA-232 receiver needs "
                        f"beyond +/-3 V; MAX13223E thresholds 0.6 / 2.4 V)"))
        curves[name] = (tt, v)
    # faults, from the datasheet (MAX13223E 19-4585 rev 1): RIN and TOUT survive +/-70 V
    for v in (14.4, 28.8, 36.0, 70.0):
        i_rx = v / 3e3 if v < 24 else v / 35e3
        i_tx = 0.08 if v < 14 else 0.006
        results.append((f"RS232: RX or TX wired to {v:g} V", "PASS",
                        f"RX takes {i_rx * 1e3:.1f} mA ({v * i_rx:.2f} W, 3 k / 35 k input), TX takes at most "
                        f"{i_tx * 1e3:.0f} mA ({v * i_tx:.2f} W); rated +/-70 V, package 1.08 W (calculated from the datasheet)"))


# --- J1 2 x 8: every pair of neighbouring cavities shorted ---------------------------------------------------------
# Each pin: what drives it from the field (worst case) and what the board puts on it. Front row 1-8, back row 9-16.
PIN_NAMES = {1: "GND", 2: "GND", 3: "RS232 TX", 4: "+5V out", 5: "CAN_L", 6: "RS485 B", 7: "DIN COM", 8: "DIN COM",
             9: "VIN", 10: "DOUT1", 11: "AIN1", 12: "RS232 RX", 13: "CAN_H", 14: "RS485 A", 15: "DIN1", 16: "DIN2"}


def pin_model(n, dout_on=False):
    p = f"p{n}"
    if n in (1, 2):
        return f"R{n} {p} 0 0.01\n"
    if n == 3:   # MAX13223E driver at mark (-6.4 V / 50 ohm, +/-80 mA, 6 mA above its 14 V overvoltage threshold)
        return (f"B{n} 0 {p} I = abs(V({p})) > 14 ? -0.006 * sgn(V({p})) : max(min((-6.4 - V({p})) / 50, 0.08), -0.08)\n"
                f"RF{n} {p} 0 5k\n")
    if n == 4:   # +5V rail: LM2596 + OR diode (cannot sink), 100 mA of board load, F801 (1.2 ohm cold); a 20 mA sensor
        return (f"V{n}s v{n}s 0 5.29\nD{n}or v{n}s rail5 DOR\nR{n}load rail5 0 49\nVF801 rail5 f{n} 0\nR{n}f f{n} {p} 1.2\n"
                f"RF{n} {p} 0 245\n")
    if n in (5, 13):   # CAN line: TJA1051 25 k to 2.5 V + SZNUP3105L on the board; the bus: the two 120 ohm terminators
        # (60 ohm) to the other line, which only the other transceivers' inputs hold at 2.5 V (two nodes: 12.5 k)
        return (f"RB{n} {p} vm{n} 25k\nVM{n} vm{n} 0 2.5\nVT{n} {p} t{n} 0\nDT{n}a m{n} t{n} NUP3105L\nDT{n}b m{n} 0 NUP3105L\n"
                f"RF{n} {p} o{n} 60\nRO{n} o{n} vf{n} 12.5k\nVFB{n} vf{n} 0 2.5\n")
    if n in (6, 14):   # RS485 line: THVD2410 96 k + SZNUP3105L; the bus: 60 ohm of terminators to the other line, which a
        # fail-safe bias somewhere on the bus holds through 330 ohm (the worst case for the bus parts)
        return (f"RB{n} {p} 0 96k\nVT{n} {p} t{n} 0\nDT{n}a m{n} t{n} NUP3105L\nDT{n}b m{n} 0 NUP3105L\n"
                f"RF{n} {p} o{n} 60\nRO{n} o{n} vf{n} 330\nVFB{n} vf{n} 0 1.65\n")
    if n in (7, 8):   # DIN COM: wired to the chassis in the harness; isolated from GND on the board
        return f"R{n} {p} 0 0.05\n"
    if n == 9:   # VIN: 12 V battery at 14.4 V; board takes 70 mA
        return f"V{n} b{n} 0 14.4\nR{n}w b{n} {p} 0.05\nR{n}load {p} 0 206\n"
    if n == 10:   # DOUT1: a 24 ohm relay coil from a 28.8 V supply; BSP75N off (open) or on (0.52 ohm, 1 A limit)
        on = f"B{n} {p} 0 I = min(V({p}) / 0.52, 1.0)\n" if dout_on else ""
        return f"V{n} b{n} 0 28.8\nR{n}load b{n} {p} 24\n" + on
    if n == 11:   # AIN1: worst case, a stiff 28.8 V being measured; board divider 110 k
        return f"V{n} b{n} 0 28.8\nR{n}w b{n} {p} 0.05\nR{n}in {p} 0 110k\n"
    if n == 12:   # RS232 RX: the other device's driver at mark (-6.4 V / 50 ohm, 80 mA limit); board input 5 k
        return (f"B{n} 0 {p} I = max(min((-6.4 - V({p})) / 50, 0.08), -0.08)\nR{n}in {p} 0 5k\n")
    if n in (15, 16):   # DIN: an active 28.8 V signal; opto input about 3 k to DIN COM (chassis)
        return f"V{n} b{n} 0 28.8\nR{n}w b{n} {p} 0.05\nR{n}in {p} 0 3k\n"
    raise ValueError(n)


LIMITS = {3: 70, 4: 5.5, 5: 58, 6: 70, 11: 60, 12: 70, 13: 58, 14: 70, 15: 50, 16: 50}


def j1_pairs():
    rows = [(k, k + 1) for k in range(1, 8)] + [(k, k + 1) for k in range(9, 16)]
    cols = [(k, k + 8) for k in range(1, 9)]
    return rows + cols


def harness_shorts(results):
    for a, b in j1_pairs():
        for dout_on in ((False, True) if 10 in (a, b) else (False,)):
            name = f"j1_{a}_{b}{'_on' if dout_on else ''}"
            netlist = pin_model(a, dout_on) + pin_model(b, dout_on) + f"VSH p{a} p{b} 0\n"
            control = "op\nprint all\nprint i(vsh)\n" + ("print i(vf801)\n" if 4 in (a, b) else "") + \
                      "".join(f"print i(vt{n})\n" for n in (a, b) if n in (5, 6, 13, 14))
            vals = run(name, netlist, control)
            v = vals.get(f"v(p{a})", vals.get(f"p{a}", 0.0))
            i_sh = vals.get("i(vsh)", 0.0)
            notes, verdict = [], "PASS"
            for n in (a, b):
                if n == 4:
                    rail = vals.get("v(rail5)", vals.get("rail5", 0.0))
                    i_f = abs(vals.get("i(vf801)", 0.0))
                    if rail > LIMITS[4]:
                        verdict = "FAIL"
                        notes.append(f"+5V rail lifted to {rail:.2f} V")
                    if i_f > 0.46:
                        verdict = "PASS*" if verdict == "PASS" else verdict
                        notes.append(f"F801 carries {i_f:.2f} A and trips")
                if n in (5, 6, 13, 14):
                    i_t = abs(vals.get(f"i(vt{n})", 0.0))
                    if i_t > 1e-3:
                        verdict = "FAIL"
                        notes.append(f"pin {n} protector conducts {i_t:.2f} A")
                if n in LIMITS and abs(v) > LIMITS[n]:
                    verdict = "FAIL"
                    notes.append(f"pin {n} at {v:.1f} V (limit {LIMITS[n]} V)")
            if 10 in (a, b) and dout_on and abs(i_sh) > 0.5:
                verdict = "PASS*" if verdict == "PASS" else verdict
                notes.append("the BSP75N current-limits and cycles on its thermal shutdown")
            pair = {a, b}
            dead = abs(i_sh) > 5
            if dead and 9 in pair:
                verdict = "PASS*"
                notes.append("VIN shorted to ground: the 1 A harness fuse at the battery blows")
            elif dead and pair & {15, 16}:
                verdict = "PASS*"
                notes.append("the DIN signal shorted to the chassis: its own circuit's fuse blows; the board sees nothing")
            elif 10 in pair and pair & {1, 2} and not dout_on:
                notes.append("the DOUT1 load switches on (its current returns on GND)")
            for n in pair & {6, 14}:
                if (pair - {n}) & {9, 10, 11, 15, 16}:
                    i_bus = (v - 1.65) / 390
                    notes.append(f"on the bus, {i_bus * 1e3:.0f} mA flow through the other devices' terminators "
                                 f"({i_bus ** 2 * 30:.2f} W each) and a 330 ohm fail-safe bias resistor ({i_bus ** 2 * 330:.1f} W)")
            state = " (DOUT1 on)" if dout_on else ""
            current = "a dead short" if dead else f"{i_sh * 1e3:+.0f} mA between the pins"
            results.append((f"J1 {a}-{b}: {PIN_NAMES[a]} / {PIN_NAMES[b]}{state}", verdict,
                            f"{v:+.1f} V at the short, {current}" + ("; " + "; ".join(notes) if notes else "")))


# --- Power budget with the new ports ------------------------------------------------------------------------------
def power(results):
    """The Micro-Fit board's budget (PINOUT.md) plus the CAN and RS232 parts, at VIN = 12 V."""
    eff, eff_max = 0.75, 0.80
    base = {"idle": (0.062, 0.067), "typical": (0.100, 0.115), "maximum": (0.28, 0.59)}   # (3V3 A, 5V A) PINOUT.md
    add = {"idle": (0.008, 0.005), "typical": (0.010, 0.020), "maximum": (0.020, 0.070)}
    # idle: MAX13223E 8 mA typ, TJA1051 recessive about 5 mA; typical: RS232 driving a 5 k load, CAN sending 25 %
    # of the time; maximum: MAX13223E 15 mA + both drivers into 3 k, TJA1051 dominant 70 mA (continuous)
    for case in base:
        i33 = base[case][0] + add[case][0]
        i5 = base[case][1] + add[case][1] + add[case][0]   # the Micro-Fit figure already holds its 3V3 load (AMS1117)
        p_in = 4.9 * i5 / (eff_max if case == "maximum" else eff)
        results.append((f"Power: {case}", "INFO",
                        f"3V3 {i33 * 1e3:.0f} mA, 5V {i5 * 1e3:.0f} mA (incl. 3V3), {p_in:.2f} W in, "
                        f"{p_in / 12 * 1e3:.0f} mA at 12 V (+{(add[case][0] + add[case][1]) * 4.9 / eff * 1e3:.0f} mW for CAN + RS232)"))


# --- Plots ---------------------------------------------------------------------------------------------------------
def style(ax, title, ylabel):
    ax.set_facecolor(SURFACE)
    ax.set_title(title, color=INK, fontsize=11, loc="left")
    ax.set_ylabel(ylabel, color=MUTED, fontsize=9)
    ax.set_xlabel("time (us)", color=MUTED, fontsize=9)
    ax.grid(color=GRID, linewidth=0.6)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=8)


def plot(curves):
    os.makedirs(PLOTS, exist_ok=True)
    fig, axes = plt.subplots(2, 1, figsize=(9, 6.2), facecolor=SURFACE)
    for ax, (name, title) in zip(axes, (("can250", "CAN 250 kbit/s (J1939): differential voltage at the board, 1 m stub"),
                                        ("can500", "CAN 500 kbit/s (OBD-II): differential voltage at the board"))):
        t, vd = curves[name]
        ax.plot(t * 1e6, vd, color=BLUE, linewidth=1.6, label="1 m stub")
        if name == "can500":
            t3, vd3 = curves["can500_3m"]
            ax.plot(t3 * 1e6, vd3, color=ORANGE, linewidth=1.2, label="3 m stub")
            ax.legend(frameon=False, fontsize=8, labelcolor=INK, loc="upper right")
        for level, text in ((0.9, "dominant above 0.9 V"), (0.5, "recessive below 0.5 V")):
            ax.axhline(level, color=MUTED, linewidth=0.8, linestyle="--")
            ax.text(t[-1] * 1e6, level, text, color=MUTED, fontsize=7, ha="right", va="bottom")
        style(ax, title, "V(CANH) - V(CANL)  (V)")
    fig.tight_layout()
    fig.savefig(os.path.join(PLOTS, "can-bus.png"), dpi=130)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(9, 3.2), facecolor=SURFACE)
    t, v = curves["rs232_115k_3k"]   # the 7 k load gives the same trace within 0.1 V
    ax.plot(t * 1e6, v, color=BLUE, linewidth=1.6)
    for level in (3.0, -3.0):
        ax.axhline(level, color=MUTED, linewidth=0.8, linestyle="--")
    ax.text(t[-1] * 1e6, 3.0, "EIA-232 receiver: beyond +/-3 V", color=MUTED, fontsize=7, ha="right", va="bottom")
    style(ax, "RS232: MAX13223E at 115.2 kbit/s, far end of the cable (3 k + 2500 pF, the worst EIA-232 load)",
          "line voltage (V)")
    fig.tight_layout()
    fig.savefig(os.path.join(PLOTS, "rs232-line.png"), dpi=130)
    plt.close(fig)


def main():
    results, curves = [], {}
    can_signal(results, curves)
    bus_faults(results)
    rs232_signal(results, curves)
    harness_shorts(results)
    power(results)
    plot(curves)
    width = max(len(r[0]) for r in results)
    for label, verdict, detail in results:
        print(f"{label:<{width}}  {verdict:6}  {detail}")
    print(f"\nplots: {os.path.join(PLOTS, 'can-bus.png')}, {os.path.join(PLOTS, 'rs232-line.png')}")


if __name__ == "__main__":
    main()
