// IClock.h — time source interface.
//
// TS mental model: `interface IClock { nowMs(): number; nowUs(): number; delayMs(ms: number): void }`
// Drivers receive an IClock instead of calling millis()/delay() directly, so
// unit tests can use a fake clock and run instantly.
#pragma once

#include <stdint.h>

class IClock {
 public:
  virtual ~IClock() = default;
  virtual uint32_t nowMs() const = 0;
  virtual uint32_t nowUs() const = 0;
  virtual void delayMs(uint32_t ms) = 0;
};
