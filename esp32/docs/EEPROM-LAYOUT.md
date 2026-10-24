# EEPROM Layout (AT24C256)

What is stored where in the 32 KB external EEPROM, and why it survives power cuts and decades of writes. Source of truth: [`lib/Storage/src/EepromLayout.h`](../lib/Storage/src/EepromLayout.h).

Since firmware 2.6.0 the EEPROM is one of two stores: the ESP32's own flash holds the same records and every save goes to both. The flash is the main store; the EEPROM's values are used when the flash has none. See [STORAGE.md](STORAGE.md).

## Map

```
 address   page      size     content
 0x0000    0         64 B     Layout header  {magic "THM1", layoutVersion, crc}
 0x0040    1-2       128 B    Settings copy A  {magic, version, seq, Settings, crc}
 0x00C0    3-4       128 B    Settings copy B
 0x0140    5-15      704 B    reserved (future use)
 0x0400    16-511    31 KB    Counter journal: 992 slots x 32 B
 0x8000    end
```

The chip has 512 pages of 64 bytes. A page write is atomic in practice: the chip latches the page, then programs it in about 5 ms. Every record is page-aligned or page-contained, so **no record ever straddles two write cycles**.

## Layout header

| Field | Type | Value |
|---|---|---|
| magic | u32 | `0x314D4854` ("THM1") |
| layoutVersion | u16 | 1 |
| crc | u16 | CRC16-CCITT-FALSE of the bytes above |

At boot: header valid → use the EEPROM as is. Header invalid (new chip, other firmware, or changed layout) → erase settings and journal, then write the header **last**. If power fails during formatting, the header is still invalid and formatting simply repeats on the next boot. Status flag `eepromFormatted` reports it.

## Settings: two copies (A/B)

`SettingsRecord` (128 B) = `magic 0x5453`, `version`, `seq`, the `Settings` struct (116 B: timing, ports, inputs, Kalman tuning, sensor calibration), `crc`.

- **Save** writes to the copy that is *not* currently active, with `seq + 1`. The active copy is untouched until the new one is verified.
- **Load** picks the valid copy with the higher `seq`. If one is corrupt, the other is used. If both are, factory defaults are used (`settingsDefaults` flag).

Settings only change when a user sends a command or completes a calibration, so wear is negligible.

## Counter journal: wear levelling

**The problem.** EEPROM cells survive about 1,000,000 writes. Saving the hour meter to one fixed address every second would wear it out in **11.6 days**.

**The solution.** A ring of 992 slots. Each save goes to the next slot:

```
 slot:   0     1     2    ...   991    0     1   ...
 seq:    1     2     3    ...   992   993   994  ...
```

`JournalRecord` (32 B):

| Field | Type | Notes |
|---|---|---|
| magic | u16 | `0x524A` |
| version | u8 | 1 |
| flags | u8 | bit0 time valid, bit1 manual preset, bit2 reset; from 2.6.0 bit3 / bit4: the hour meter / totalizer counts from zero, its real value unknown ([STORAGE.md](STORAGE.md)) |
| seq | u32 | +1 per save; the highest valid one is current |
| runSeconds | u32 | hour meter |
| totalCount | u32 | totalizer pulses |
| epoch | u32 | UTC time of the save (0 if unknown) |
| lineage | u32 | history id (from 2.6.0; 0 = written by older firmware) |
| reserved | 6 B | zero |
| crc | u16 | CRC16 of the 30 bytes above |

**Endurance:**

| Save interval | Each slot rewritten every | Lifetime of the 1M-cycle cells |
|---|---|---|
| 10 s (minimum setting) | 2.75 h | ~314 years |
| 60 s (default) | 16.5 h | ~1,890 years |

In practice the device saves only while the engine runs (nothing changes otherwise), plus once on each engine stop.

**Power-cut safety.** Boot scans all 992 slots (≈ 0.8 s at 400 kHz) and keeps the highest `seq` whose CRC is valid. A write torn by a power cut has a bad CRC and is ignored, so the hour meter rolls back to the previous save, at most one interval (default ≤ 60 s). It can never jump to a garbage value. The next save overwrites the damaged slot.

**Write verification.** Every page is read back after writing (`At24c::verify`). A mismatch reports `storageError` and is retried after one interval.

## Changing the layout

1. Edit `EepromLayout.h` and update this document.
2. Increment `layout::kLayoutVersion`. Devices reformat the EEPROM **once** on the next boot. From firmware 2.6.0 the flash copy refills it, so nothing is lost; a device without the flash store (`flashStoreMissing`) loses its settings and counters, so preset the hour meter again afterwards (`setRunSeconds`).
3. If only the `Settings` struct changes, increment `SettingsStore::kVersion` instead. Old settings are then ignored (defaults used) while the counters are kept.
