// Check.h — the only two macros in the project (NASA rule: limit the preprocessor).
//
// CHECK_ARG(cond)  validate an input; return Status::InvalidArg if false.
//                  TS: if (!cond) return 'InvalidArg';
// TRY(expr)        run something that returns Status; return early on failure.
//                  TS: const s = expr; if (s !== 'Ok') return s;
#pragma once

#include "Status.h"

#define CHECK_ARG(cond)                \
  do {                                 \
    if (!(cond)) {                     \
      return Status::InvalidArg;       \
    }                                  \
  } while (0)

#define TRY(expr)                      \
  do {                                 \
    const Status tryStatus_ = (expr);  \
    if (tryStatus_ != Status::Ok) {    \
      return tryStatus_;               \
    }                                  \
  } while (0)
