# Storage: ESP32 flash and EEPROM

Where the hour meter, the totalizer and the settings are kept, and why they survive power cuts, a dead EEPROM and firmware updates. Applies to firmware 2.6.0 and later. Before 2.6.0 the EEPROM was the only store.

## In short

- **Two stores.** The ESP32's own flash (partition `hmdata`, always there) is the **main store**. The AT24C256 EEPROM on the I2C bus is optional; when fitted, it is a copy.
- **Every save goes to both**, with the same sequence number (`seq`, reported as `journalSeq`, tag 7).
- **The flash is the main store.** It gets every save. The EEPROM's values are used when the flash has none: a new ESP32 board, or the first boot after updating to 2.6.0. Whichever store does not hold the values in use is brought up to date at once, so from then on either store alone can carry the device.
- **Every counter record carries a history id.** It tells the device's own saves from those of another chip or device.
- **Same history: the newest save wins.** Normally both stores hold it. The EEPROM is ahead only when the history went on without this flash: the EEPROM ran in another ESP32 (a board swapped out and back in), or flash writes failed. At boot its values are taken. Plugged in while running, what the other ESP32 counted is added to what this one counted meanwhile.
- **Another history: added only where the device counted from zero.** This covers an older chip, another device's EEPROM, or one the device could not read at boot. Its hour meter and totalizer are **added** to any counter the device has been counting from zero without knowing its real value, because the engine time in both is real. Counters the device knows (stored, set with `setRunSeconds` / `setTotalCount`, reset, or added once already) keep their value, and the EEPROM is given the device's values.
- **The same rules apply at boot and when an EEPROM is plugged in while running.** A record the device wrote itself is never added again.

The device does not need the EEPROM any more. When it is fitted, it is a second copy that also travels with the board.

## What happens when

| Situation | What the device does |
|---|---|
| First boot after updating to 2.6.0, EEPROM fitted | The EEPROM's values are used (the flash is still empty) and copied into the flash at once |
| The EEPROM dies or is removed | Nothing is lost: the flash holds the same values. `eepromMissing` is now a warning, not a fault |
| A new, blank EEPROM is fitted | It is formatted (`eepromFormatted`) and filled from the flash |
| An EEPROM that missed some saves comes back | Same history: the flash is ahead. The EEPROM is updated |
| The EEPROM could not be read at the first boot of 2.6.0, but answers later (at a later boot, or while running) | The device counted from zero meanwhile: the EEPROM's hour meter and totalizer are added to those counts, once |
| The EEPROM failed, the hour meter was set by hand (`set-hours`), then the old EEPROM answers again | The values set by hand win; the old EEPROM is overwritten with them |
| Flash writes fail for a while (the EEPROM keeps the saves), then work again | Same history: the EEPROM's newer save wins at the next boot, and the flash gets it |
| An EEPROM from another device is fitted | The device's own counters and settings win and the EEPROM is overwritten. The exception is counters the device has been counting from zero: the EEPROM's values are added to those |
| Board X is swapped out, its EEPROM runs in board Y, then X comes back with it | Same history, and the EEPROM has the newer saves: X takes them at boot. If the EEPROM answers only while X runs, what Y counted is added to what X counted meanwhile. A counter set by hand on X since the EEPROM left keeps its value |
| A new ESP32 board with the old EEPROM | The flash is empty: the EEPROM's values are used and copied into the flash |
| Safe mode (I2C off after repeated restarts) | The counters and settings come from the flash, and saves go to the flash |
| Restart because the I2C bus is stuck (`i2cStuck`) | The last counts are saved to the flash first; the EEPROM is skipped |
| `setRunSeconds`, `setTotalCount`, `resetCounters` without an EEPROM | They work: the flash keeps the new values |
| Partition table older than 2.6.0 (an app-only update) | Flag `flashStoreMissing`: the EEPROM is the only store, as before 2.6.0. Flash the full image to add `hmdata` |
| The EEPROM's scan fails halfway (a loose contact) | It counts as not fitted, and the presence check tries again 2 s later. A half-read journal is never used |
| Running an older firmware for a while, then 2.6.0 again | The older firmware saved only to the EEPROM, but the flash still wins. Update with `hour-meter firmware flash`: it backs up the counters first and puts them back. Otherwise the counts made on the older firmware are lost |

**Limit: two boards counting at the same time.** Suppose the EEPROM ran in board Y while board X kept running without it. Both continued the same history, and the two branches cannot be merged exactly. At boot the branch with the newer save wins, and the other one's counts are lost. Set the hour meter by hand if that happens.

**Settings** have no history id. They follow the main-store rule: the flash's settings win, and the EEPROM's are used when the flash has none. The two copies are compared by content, so another device's EEPROM always gets the device's settings. An EEPROM plugged in while running gives its settings only while the device still runs on the defaults it found at boot and no host has sent settings since. Settings that did not change are not saved again, so a host that resends its settings does not wear out the flash. After a store missed a save (`storageError`), resending the same settings retries that store; a flash that already has them is not written again.

## The flash store

`hmdata` is a 64 KB data partition at `0x310000` ([`partitions.csv`](../partitions.csv)), carved from the unused `spiffs` area. The firmware finds it by its label ([`PartitionFlash.h`](../src/platform/PartitionFlash.h)). The format is defined in [`FlashStore.h`](../lib/Storage/src/FlashStore.h):

```
 sector  offset    content
 0       0x0000    settings copy A   (one SettingsRecord)
 1       0x1000    settings copy B
 2-15    0x2000    counter journal: 14 sectors x 128 slots of 32 B = 1,792 slots
```

The records are the same as in the EEPROM: `SettingsRecord` and `JournalRecord`, each with magic, version, `seq` and CRC, and on `JournalRecord` the history id and the counting-from-zero flags ([EEPROM-LAYOUT.md](EEPROM-LAYOUT.md)). Only the way they are written differs. Flash can only clear bits when it writes, and only erasing a whole 4 KB sector sets them back to `0xFF`:

- **Counters.** Each save goes to the next slot of the ring. Entering a new sector erases it first. That sector holds the oldest records, never the newest one. A slot that is not blank (a write cut short by a power loss) is skipped. Every record is read back after writing.
- **Settings.** A save erases the copy that is *not* in use, writes the new record there and reads it back. The copy in use is never touched.
- **Boot.** All 1,792 slots (56 KB, a few milliseconds) and both settings copies are read. In each, the valid record with the highest `seq` is the flash's newest.

**Power-cut safety.** It works as in the EEPROM. A write cut short leaves a record with a bad CRC, which is ignored, so the device falls back to the previous save and loses at most one save interval. An erase cut short only damages the sector with the oldest records. The newest record is never in that sector, so nothing current is lost.

**Endurance.** A flash sector survives about 100,000 erases. With 1,792 slots, each sector is erased once per lap of the ring:

| Save interval | Saves a day (engine running 24 h) | Each sector erased | Lifetime |
|---|---:|---:|---:|
| 10 s (minimum setting) | 8,640 | 4.8 times a day | ~57 years |
| 60 s (default) | 1,440 | 0.8 times a day | ~340 years |

In practice the device saves only while the engine runs, plus once at every engine stop. Settings are saved only when a user changes them or finishes a calibration.

## Pulse input during flash writes

While the ESP32 writes or erases its flash, the CPU's flash cache is off. The pulse interrupt is not in IRAM, so it waits, and edges that arrive meanwhile are counted as one. A 32-byte save takes about 1 ms. A sector erase takes about 45 ms (up to 400 ms) and happens once every 128 saves.

At 1 kHz of pulses and the default 60 s interval, that loses about 44 pulses per 2 hours of running, about 0.0006 %. That is far below the accuracy of any flow meter. The hour meter is not affected: run time comes from the clock, not from interrupts.

## Firmware updates

- **What adds `hmdata`.** The partition table of 2.6.0 adds `hmdata`. `nvs`, `otadata` and `app0` keep their offsets, so the Bluetooth pairing survives the update. `hour-meter firmware flash` (merged image) and `pio run -e esp32dev -t upload` write the new table. Flashing only the app (`firmware.bin`) keeps the old table, and the device then reports `flashStoreMissing`.
- **What leaves it alone.** `hmdata` lies after the firmware image, so an update does not overwrite it. `hour-meter firmware flash` also skips `hmdata` and `nvs` when an image is padded over them.
- **What erases it.** `pio run -t erase` and `esptool erase_flash` do. With an EEPROM fitted, the next boot fills the flash again from the EEPROM. Without one, the counters and settings are gone.

## Status flags

| Flag | Meaning |
|---|---|
| `eepromMissing` (bit 0) | No EEPROM. A warning from 2.6.0: the flash keeps everything |
| `flashStoreMissing` (bit 19) | No usable `hmdata` partition: missing (flash the full image) or unreadable at boot. The EEPROM is the only store |
| `storageError` (bit 9) | The last save failed in one of the stores (the other one may still have it), or the EEPROM could not be formatted or read |
| `settingsNotSaved` (bit 17) | Settings changed with no store at all (no `hmdata`, no EEPROM). They are in RAM until an EEPROM is attached |
| `journalEmpty`, `settingsDefaults` (bits 8, 7) | Neither store held counters / settings at boot |
| `eepromFormatted` (bit 13) | A blank or foreign EEPROM was initialised at this boot |

`settingsSource` (tag 60) says which copy the settings in use came from: 1/2 EEPROM copy A/B, 3/4 flash copy A/B, 0 defaults. Full tables: [INTEGRATION-GUIDE §5.5](INTEGRATION-GUIDE.md#55-status-flags-tag-53).

## Code

| File | Job |
|---|---|
| [`StorageMirror.h`](../lib/Storage/src/StorageMirror.h) | Two copies: the flash is the main store and both get every save. Within one history the newest save wins; another history is added to the counters counted from zero |
| [`FlashStore.h`](../lib/Storage/src/FlashStore.h) | Settings A/B and the counter journal on NOR flash |
| [`Journal.h`](../lib/Storage/src/Journal.h), [`SettingsStore.h`](../lib/Storage/src/SettingsStore.h) | The same records in the EEPROM |
| [`PartitionFlash.h`](../src/platform/PartitionFlash.h) | The `hmdata` partition via ESP-IDF's partition API |
| [`test_storage`](../test/test_storage/test_main.cpp) | Power cuts mid-write and mid-erase, wear, a failing flash, and the boot and hot-plug rules above, on fake flash and a fake EEPROM |
