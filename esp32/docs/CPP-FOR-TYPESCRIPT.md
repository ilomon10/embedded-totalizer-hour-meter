# C++ for TypeScript Developers

A field guide to reading this firmware with a TypeScript background. Every example comes from this codebase. It covers only the C++ the project actually uses.

## 1. The big differences

| TypeScript | This firmware | Why |
|---|---|---|
| Garbage-collected heap | **No heap at all.** Objects are members or static | 320 KB RAM, running for years: fragmentation would eventually crash it |
| `throw` / `try` | Return `Status` / `Result<T>` | Errors are values you must handle (like Go or Rust) |
| `async` / `await`, event loop | One `loop()` called forever, plus polled timers | Same idea as the Node event loop, but you write the loop |
| `number` | `uint8_t`, `int16_t`, `uint32_t`, `float`… | You choose size and sign; overflow wraps silently |
| `npm` packages | `lib/<Name>/` folders + `library.json` | PlatformIO builds them like workspace packages |
| `jest` | `pio test -e native` (Unity) with fakes | Tests run on your PC, not on the chip |

## 2. Side by side

### Types and interfaces

```ts
// TypeScript
interface II2cBus {
  write(addr: number, data: Uint8Array): Status;
}
class FakeI2cBus implements II2cBus { ... }
```

```cpp
// C++ (lib/I2cBus/src/II2cBus.h)
class II2cBus {
 public:
  virtual ~II2cBus() = default;
  virtual Status write(uint8_t addr, const uint8_t* data, size_t len) = 0;  // "= 0" means abstract
};
class FakeI2cBus : public II2cBus { ... Status write(...) override { ... } };
```

`virtual … = 0` is an interface method, and `override` is `implements` checked by the compiler. A `Uint8Array` becomes a pointer plus a length: `const uint8_t* data, size_t len`.

### Plain objects → `struct`

```ts
type DateTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };
```

```cpp
struct DateTime {        // lib/Ds3231/src/DateTime.h
  uint16_t year = 2000;  // default values like a TS class field initializer
  uint8_t month = 1;
  ...
};
```

### Union types for errors → `Status` and `Result<T>`

```ts
type Result<T> = { ok: true; value: T } | { ok: false; status: Status };

const r = rtc.nowEpoch();
if (!r.ok) return r.status;
use(r.value);
```

```cpp
Result<uint32_t> r = rtc.nowEpoch();   // lib/Core/src/Result.h
if (!r.ok()) { return r.status; }
use(r.value);
```

`TRY(expr)` is shorthand for "run it; if it failed, return the error" (like `await` letting a rejection propagate):

```cpp
TRY(bus_.write(address_, tx, 2 + len));   // returns early on any non-Ok Status
TRY(waitReady());
return verify(memAddr, data, len);
```

### Enums

```ts
enum StreamMode { Off = 0, Raw = 1, Filtered = 2, Both = 3 }
```

```cpp
enum class StreamMode : uint8_t { Off = 0, Raw = 1, Filtered = 2, Both = 3 };  // ": uint8_t" = stored in 1 byte
auto m = static_cast<StreamMode>(settings.streamMode);                         // explicit cast from a number
```

### Constants and modules

```ts
export const kResetMagic = 0x5245534e;
export namespace tag { export const runSeconds = 1; }
```

```cpp
constexpr uint32_t kResetMagic = 0x5245534E;               // compile-time constant (like `as const`)
namespace tag { constexpr uint8_t kRunSeconds = 1; }       // used as tag::kRunSeconds
namespace { int helper(); }                                 // anonymous namespace = not exported
```

### Dependency injection

```ts
class At24c { constructor(private bus: II2cBus, private clock: IClock) {} }
```

```cpp
class At24c {
 public:
  At24c(II2cBus& bus, IClock& clock) : bus_(bus), clock_(clock) {}  // ": bus_(bus)" initializes members
 private:
  II2cBus& bus_;   // "&" = reference: like a non-null object pointer that can't be reassigned
  IClock& clock_;
};
```

### `setInterval` → `PeriodicTask`

```ts
setInterval(() => sampleImu(), 10);
```

```cpp
PeriodicTask imuTask_{10000};               // period in microseconds
void loop() {
  if (imuTask_.due(micros())) { sampleImu(); }   // polled; no callbacks, no drift
}
```

### Generics → templates

```ts
class FrameWriter<N extends number> { private buf = new Uint8Array(N); }
```

```cpp
template <size_t N = 128>
class SensorFrameWriter { uint8_t buf_[N]; };   // N is fixed at compile time: memory known before running
SensorFrameWriter<64> small;                    // like FrameWriter<64>
```

## 3. Things that bite TypeScript developers

| Gotcha | Example | How this code avoids it |
|---|---|---|
| Integer overflow wraps | `uint8_t x = 255; x++;` gives 0 | Wide types for counters (`uint32_t` runSeconds ≈ 136 years) |
| Integer division truncates | `7 / 2` is `3` | Float literals where needed: `1.0f / hz` |
| Unsigned subtraction | `now - last` when `now < last` wraps | Used on purpose for `millis()` wrap-around: `(now - last) >= period` stays correct |
| Uninitialised memory | `uint8_t buf[8];` holds garbage | Default member initialisers `= 0`, `{}` |
| `float` is 32-bit | ~7 significant digits | Counters are integers; only sensor maths uses float |
| Struct padding | the compiler inserts gaps | `static_assert(sizeof(...))` + explicit `reserved` fields in stored records |
| Dangling references | keeping a pointer into a buffer that gets reused | `SensorFrameView` is documented as valid only inside the callback |
| `[[nodiscard]]` errors | `eeprom.write(...);` won't compile | Handle it, or write `(void)eeprom.write(...);` to ignore on purpose |

## 4. Reading order for this codebase

1. `lib/Core/src/Status.h`, `Result.h`, `Check.h`: the error model.
2. `lib/App/src/Protocol.h`: every tag the device speaks.
3. `src/Application.cpp`: `setup()` and `loop()`, the whole program in one file.
4. `lib/App/src/HourMeter.cpp`: the main feature, pure logic.
5. `test/test_app/test_main.cpp`: how it all behaves, as executable examples.
