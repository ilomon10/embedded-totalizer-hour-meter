# PSU-B: 9–36 V → 5.3 V plug-on supply

A 40 × 30 mm, 2-layer board that plugs onto the [main board](../hour-meter-board/README.md)'s J102 socket. It turns the vehicle supply (12 V or 24 V systems, 9–36 V) into 5.28 V for the main board. The supply is a separate board so it can be swapped: for example a cheaper 12 V-only version, or an LM2596 module wired to J102, without changing the main board.

| | |
|---|---|
| Schematic | `hour-meter-psu-b.kicad_sch` (flat) |
| PCB | `hour-meter-psu-b.kicad_pcb`, routed, GND pour on both layers |
| Script | `tools-pcb.py` with `check`, `place` or `route` (shares helpers with the main board's `tools-build-pcb.py`) |
| Ready to order | `production/`: Gerber zip, `BOM-hour-meter-psu-b.csv`, `CPL-hour-meter-psu-b.csv`, written by `../hour-meter-board/tools-production.py ../hour-meter-psu-b/hour-meter-psu-b.kicad_pcb` |

**Vehicle faults** ([simulated](../fault-analysis/README.md)):
- **Passes:** reverse polarity, a 36 V jump start, ISO 7637-2 pulses 1 and 2a, and a 12 V vehicle's clamped load dump (35 V).
- **Fails:** a **24 V vehicle's clamped load dump (58–65 V for up to 400 ms)**. D1 starts conducting at 40 V and would have to absorb 21–87 J; it survives about 16 J. For 24 V vehicles, use a supply with a 100 V-class converter and a TVS that stays off at 58 V. It plugs into the same J102.

**Checks:** ERC 0 errors and 0 warnings. DRC 0 errors, 0 unconnected, 0 schematic-parity issues; the 10 warnings are reference-text silkscreen overlaps. All parts are in JLCPCB stock for 10 boards (2026-10-21).

## Circuit

Based on TI's TPS54360B reference design (datasheet SNVSB93, Figure 32: 8.5–60 V in, 5 V, 600 kHz), with the feedback set for 5.28 V and a smaller inductor sized for a ~1 A load.

| Part | Value | Why |
|---|---|---|
| D1 | SMBJ36CA, bidirectional | 36 V standoff (the top of the 9–36 V range), about 58 V clamp. That stays under the TPS54360B's 65 V absolute maximum and the B560C's 60 V. It sits *before* D2, so both polarities are clamped |
| D2 | SS510 (100 V) | Reverse-polarity block |
| C1–C4 | 100 µF/63 V + 2 × 2.2 µF/100 V + 100 nF/100 V | Bulk plus TI's 2 × 2.2 µF ceramics |
| U1 | TPS54360BDDAR | 4.5–60 V, 3.5 A, current mode, Eco-mode |
| R3 | 162 k | f<sub>SW</sub>: R<sub>T</sub>(kΩ) = 101756 · f<sub>SW</sub>(kHz)<sup>−1.008</sup> → about 600 kHz. The minimum on-time at 36 V is about 245 ns, well above the 135 ns limit |
| R5 / R6 | 56 k / 10 k | V<sub>OUT</sub> = 0.8 V · (1 + 56/10) = **5.28 V**. The main board's SS34 OR-diode leaves about 4.9 V |
| R1 / R2 | 510 k / 82 k | UVLO from TI eq. 4–5 (I<sub>1</sub> = 1.2 µA, I<sub>HYS</sub> = 3.4 µA, V<sub>EN</sub> = 1.2 V): **start 8.05 V, stop 6.31 V**. EN reaches 8.0 V at the 58 V TVS clamp, under its 8.4 V absolute maximum |
| R4, C8, C9 | 13 k, 6.8 nF, 39 pF | Type 2A compensation, TI reference values |
| L1 | 8.2 µH SWPA8040S (I<sub>sat</sub> 4.2 A) | TI reference inductor value |
| C6, C7 | 2 × 47 µF/16 V X5R 1206 | Output. These lose capacitance at 5.3 V, so **check the load-step response at bring-up** and add a third 47 µF if it rings |
| D3 | B560C (60 V 5 A) | Catch diode, as in the TI design |
| D4 + R7 | Red LED, 2.2 k | Power indicator, 1.5 mA |

**P1 pinout** matches main-board J102: 1 VIN, 2 GND, 3 VOUT, 4 VOUT, 5 GND, 6 VIN. It is symmetric under a 180° rotation, so a board plugged in rotated still sees VIN→VIN, GND→GND and VOUT→VOUT.

## Mechanics

- **Position:** the board sits over the main board's PSU area. Local coordinates map to the main board as (x + 13, y + 1).
- **Alignment:** P1 lines up with J102, and H1 (M3) lines up with the main board's H101 standoff.
- **P1 header:** it is mounted on the **bottom** of the PSU board, and in KiCad it is a B.Cu footprint. This matters because KiCad's PinSocket footprint (J102) is the mirror image of its PinHeader footprint: seen from the top, socket pin 2 is left of pin 1 while header pin 2 is right of it. Only the flipped header has the socket's pad layout, so each pin lands on the same-numbered pin.
- **Alignment check:** `tools-pcb.py` places P1 by its pad 1 and stops if any pad misses its J102 counterpart. The CPL lists P1 as a bottom-side THT part: hand-solder it, or order JLC THT assembly.
- **Height:** C1 is 12.5 mm tall, on the top side. Main-board parts under the PSU are all SMD and under 5 mm.

## Before you order

- **Layout:** the board is auto-routed. Tighten the hot loop by hand (C2/C3 → U1 VIN/GND → D3 → C2/C3 GND), keep the SW node small, and route FB away from SW and L1. See the TPS54360B datasheet, §10 Layout.
- **Assembly:** C1 (radial, THT, top) and P1 (pin header, bottom side) are hand-soldered. Everything else is SMD, top side.
- **JLCPCB assembly:** at 40 × 30 mm the board is below Standard PCBA's 70 × 70 mm minimum. Use Economic (top side, C1 included) and hand-solder P1.
- **Order number:** the bottom silkscreen carries `JLCJLCJLCJLC` in the middle of the board. Select **Order Number → Specify Position** on the order form ([JLCPCB help](https://jlcpcb.com/help/article/how-to-remove-order-number-from-your-pcb)).

## Bring-up

1. **Power the PSU board alone** from a current-limited bench supply.
   - At 9, 12, 24 and 36 V in, VOUT reads 5.28 V ± 2 %.
   - It starts at about 8 V and stops at about 6.3 V.
   - With the input reversed, it draws nothing.
2. **Load step:** step the load from 0.1 A to 1 A and watch VOUT. It should settle without ringing; if it rings, add output capacitance or re-check the compensation.
3. **Then plug it onto the main board.**
