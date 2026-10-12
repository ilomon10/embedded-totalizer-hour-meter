// Result.h — a value OR an error, never both.
//
// TypeScript mental model:
//   type Result<T> = { ok: true; value: T } | { ok: false; status: Status };
//
//   Result<float> r = sensor.read();
//   if (!r.ok()) { return r.status; }   // like: if (!r.ok) return r;
//   use(r.value);
//
// No exceptions and no heap: T is stored inline.
#pragma once

#include "Status.h"

template <typename T>
struct [[nodiscard]] Result {
  T value{};
  Status status = Status::Ok;

  bool ok() const { return status == Status::Ok; }

  static Result success(const T& v) {
    Result r;
    r.value = v;
    r.status = Status::Ok;
    return r;
  }

  static Result failure(Status s) {
    Result r;
    r.status = (s == Status::Ok) ? Status::InvalidArg : s;  // a failure is never Ok
    return r;
  }
};
