# Coding Standard

Rules for all firmware code. They are adapted from NASA/JPL's **"Power of 10: Rules for Developing Safety-Critical Code"** (G. J. Holzmann, 2006) and the JPL Institutional Coding Standard, translated to C++ and to this project. Every rule exists because embedded failures are silent and expensive: a frozen hour meter in a field machine looks exactly like a working one.

The build enforces what it can: `-Wall -Wextra -Werror`, `[[nodiscard]]` on every error type, `pio check` (clang-tidy), and unit tests under AddressSanitizer + UBSan.

## The rules

| # | Rule | How it shows up here |
|---|---|---|
| 1 | **Simple control flow.** No `goto`, `setjmp`, or recursion | Loops and early `return` only. Call depth is static and small |
| 2 | **Every loop has a fixed upper bound** | I2C retries (`kMaxAttempts = 3`), ACK polling (`kWriteCycleTimeoutMs`), journal scan (`kJournalSlots`), bus recovery (9 clocks). No `while (!ready)` without a limit |
| 3 | **No dynamic memory after startup** (we use none at all) | No `new`, `malloc`, `String`, `std::vector`. Buffers are members sized by template parameters; `Application` is a static object |
| 4 | **Short functions** (≤ 60 lines, one job) | Split into named steps, e.g. `initStorage / initRtc / initImu` |
| 5 | **Check inputs and invariants** | `CHECK_ARG(...)` at the top of public functions; `static_assert` for struct sizes and layout; plausibility checks on sensor data (stuck, saturated, range) |
| 6 | **Smallest possible scope** | Helpers in anonymous namespaces; `const` locals; members `private` by default |
| 7 | **Check every return value** | Fallible functions return `Status` or `Result<T>`, both `[[nodiscard]]`, so ignoring one is a compile error. An intentional ignore is written `(void)call();` |
| 8 | **Limit the preprocessor** | Only `#pragma once`, `#include`, `#ifdef ARDUINO`, and two macros (`CHECK_ARG`, `TRY`). Constants are `constexpr` |
| 9 | **Limit pointers** | References for required objects; raw pointers only for byte buffers and optional values. Function pointers only at the two library-callback boundaries (`SensorFrameReader`, `SerialLink`), documented there |
| 10 | **Zero warnings, static analysis clean, tests green** before merging | `pio run`, `pio check`, `pio test -e native`, `./scripts/check-docs.ts` |

## Project-specific rules

- **Persisted data carries magic + version + CRC** (`JournalRecord`, `SettingsRecord`, `LayoutHeaderRecord`), and `crc` must be the last field (enforced by `static_assert`). Corrupt data falls back to the previous copy or to defaults. It never crashes and is never silently used.
- **Never trust the bus.** Every I2C transfer has a timeout; a stuck bus is recovered (9 clocks + STOP); NACK is an answer, not a retry reason.
- **Degrade, don't die.** A missing chip sets a status flag and the rest keeps working.
- **No blocking in the loop** beyond one bounded transfer. Long operations (calibration) are state machines advanced by the loop.
- **ISRs only count.** The pulse ISR increments a counter under a spinlock; everything else happens in the loop.
- **Units in names or comments** (`intervalMs`, `accelG`, `tempQuarterC`). Wire values are scaled integers, documented in `Protocol.h`.
- **One source of truth.** Tags live in `Protocol.h`, setting ranges in `SettingsSchema.cpp`, pins in `BoardPins.h`. Docs and the host tag table (`configurator/src/tags.ts`) are checked against them by `scripts/check-docs.ts`.
- **Time is UTC.** No timezone logic in firmware, ever.

## Style

- Files: `PascalCase.h/.cpp` per class; one class per file pair; header comment says *what* and *why*.
- Names: `PascalCase` types, `camelCase` functions/variables, `trailing_` members, `kConstant` constants, `snake_case` namespaces.
- Format: 2-space indent, 120 columns, braces on every `if`/loop body.
- Errors: return `Status::X`; never `abort()`, `assert()` or exceptions in firmware.

## Before you commit

```bash
cd esp32
pio run -e esp32dev          # zero warnings (warnings are errors)
pio check -e esp32dev        # zero clang-tidy defects
pio test -e native           # all unit tests, with sanitizers
./scripts/check-docs.ts      # docs, host tag table and firmware agree (needs Deno)
```
