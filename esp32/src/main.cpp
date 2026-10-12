// main.cpp — Arduino entry points. All logic lives in Application (src/) and
// the libraries in lib/; this file only forwards setup() and loop().
#include <Arduino.h>

#include "Application.h"

namespace {
Application app;  // static allocation: no heap (see docs/CODING-STANDARD.md)
}  // namespace

void setup() { app.setup(); }

void loop() { app.loop(); }
