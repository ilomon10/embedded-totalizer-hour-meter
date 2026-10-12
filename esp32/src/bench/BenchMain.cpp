// BenchMain.cpp — module bench-test firmware (env:bench). NOT the product firmware.
//
// Test every module on its own BEFORE soldering it into the board:
//   pio run -e bench -t upload && pio device monitor -b 115200
// Wire just the module under test to the ESP32 (see docs/TESTING-MODULES.md),
// press its key, read PASS / WARN / FAIL. It reuses the production drivers, so
// a module that passes here behaves the same in the real firmware.
//
// Keys:  s I2C scan   e EEPROM   r RTC   i IMU   o 817 inputs   p power checklist
//        a all automatic tests   t <epoch>  set RTC to a UTC epoch   h help
#include <Arduino.h>

#include "../platform/ArduinoClock.h"
#include "ArduinoI2cBus.h"
#include "At24c.h"
#include "BoardPins.h"
#include "Ds3231.h"
#include "Mpu9250.h"
#include "RunningStats.h"

namespace {

enum class Verdict : uint8_t { Pass, Warn, Fail, Skip };

ArduinoClock gClock;
ArduinoI2cBus gBus(Wire, pins::kI2cSda, pins::kI2cScl, pins::kI2cFrequencyHz);

const char* verdictText(Verdict v) {
  switch (v) {
    case Verdict::Pass: return "PASS";
    case Verdict::Warn: return "WARN";
    case Verdict::Fail: return "FAIL";
    default: return "SKIP";
  }
}

Verdict report(const char* test, Verdict v, const char* detail) {
  Serial.printf("  [%s] %-8s %s\n", verdictText(v), test, detail);
  return v;
}

void printHelp() {
  Serial.println();
  Serial.println("=== Hour meter module bench test ===");
  Serial.println("  s  I2C scan (what is connected?)");
  Serial.println("  e  AT24C256 EEPROM   (non-destructive: saves and restores the test area)");
  Serial.println("  r  DS3231 RTC        (time valid, ticking, temperature)");
  Serial.println("  i  MPU9250 IMU       (keep it flat and still)");
  Serial.println("  o  817 module inputs (live levels of GPIO27 / GPIO26 for 20 s)");
  Serial.println("  p  power / LM2596 checklist (multimeter)");
  Serial.println("  a  run all automatic tests (s e r i)");
  Serial.println("  t <epoch>  set the RTC to a UTC epoch, e.g. t 1791376496");
  Serial.println("  h  this help");
}

// ------------------------------------------------------------------ I2C ----

const char* knownDevice(uint8_t addr) {
  switch (addr) {
    case i2c_addr::kEeprom: return "AT24C256 EEPROM";
    case i2c_addr::kRtc: return "DS3231 RTC (or MPU9250 with AD0 low: WRONG, must be 0x69)";
    case i2c_addr::kImu: return "MPU9250 IMU";
    case i2c_addr::kMag: return "AK8963 magnetometer (visible after IMU init)";
    case i2c_addr::kRtcModuleEeprom: return "AT24C32 on the ZS-042 RTC board (unused)";
    default: return "unknown";
  }
}

Verdict testScan() {
  Serial.println("\n-- I2C scan (SDA 21, SCL 22) --");
  uint8_t found = 0;
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    if (gBus.probe(addr) == Status::Ok) {
      Serial.printf("  0x%02X  %s\n", addr, knownDevice(addr));
      found++;
    }
  }
  if (found == 0) {
    return report("scan", Verdict::Fail, "nothing answers: check 3V3, GND, SDA/SCL swapped, pull-ups");
  }
  return report("scan", Verdict::Pass, "see list above");
}

// --------------------------------------------------------------- EEPROM ----

Verdict testEeprom() {
  Serial.println("\n-- AT24C256 EEPROM (0x50) --");
  At24c eeprom(gBus, gClock, i2c_addr::kEeprom);
  if (eeprom.begin() != Status::Ok) {
    return report("eeprom", Verdict::Fail, "no answer at 0x50 (A0-A2 must be GND)");
  }
  constexpr uint32_t kAddr = 0x7F80;  // last two pages; restored afterwards
  uint8_t saved[128], pattern[128], back[128];
  if (eeprom.read(kAddr, saved, sizeof(saved)) != Status::Ok) {
    return report("eeprom", Verdict::Fail, "read failed");
  }
  for (size_t i = 0; i < sizeof(pattern); i++) {
    pattern[i] = static_cast<uint8_t>(i * 37 + 0x5A);
  }
  const uint32_t t0 = millis();
  const Status w = eeprom.write(kAddr + 16, pattern, 96);  // crosses a page boundary on purpose
  const uint32_t ms = millis() - t0;
  const Status r = eeprom.read(kAddr + 16, back, 96);
  const bool same = (w == Status::Ok && r == Status::Ok && memcmp(pattern, back, 96) == 0);
  const Status restore = eeprom.write(kAddr, saved, sizeof(saved));
  char detail[96];
  (void)snprintf(detail, sizeof(detail), "write+verify 96 B across a page edge in %lu ms (%s)",
           static_cast<unsigned long>(ms), statusName(w));
  if (!same) {
    return report("eeprom", Verdict::Fail, detail);
  }
  if (restore != Status::Ok) {
    return report("eeprom", Verdict::Warn, "test passed but restoring the old bytes failed");
  }
  return report("eeprom", Verdict::Pass, detail);
}

// ------------------------------------------------------------------ RTC ----

Result<uint8_t> rtcSecondsRaw() {
  uint8_t sec = 0;
  const Status s = readReg(gBus, i2c_addr::kRtc, ds3231::kRegSeconds, sec);
  return s == Status::Ok ? Result<uint8_t>::success(ds3231::bcdToBin(sec & 0x7F)) : Result<uint8_t>::failure(s);
}

Verdict testRtc() {
  Serial.println("\n-- DS3231 RTC (0x68) --");
  Ds3231 rtc(gBus, i2c_addr::kRtc);
  if (rtc.begin() != Status::Ok) {
    return report("rtc", Verdict::Fail, "no answer at 0x68");
  }
  const Result<uint8_t> s1 = rtcSecondsRaw();
  delay(2100);
  const Result<uint8_t> s2 = rtcSecondsRaw();
  const int diff = (static_cast<int>(s2.value) - static_cast<int>(s1.value) + 60) % 60;
  if (!s1.ok() || !s2.ok() || diff < 1 || diff > 3) {
    return report("rtc", Verdict::Fail, "seconds register is not ticking");
  }
  const Result<int16_t> temp = rtc.temperatureQuarterC();
  const float c = temp.value / 4.0f;
  Serial.printf("  temperature %.2f C\n", c);
  if (!temp.ok() || c < -20 || c > 70) {
    return report("rtc", Verdict::Warn, "ticking, but temperature reading implausible");
  }
  const Result<uint32_t> now = rtc.nowEpoch();
  if (now.status == Status::TimeInvalid) {
    return report("rtc", Verdict::Warn, "ticking; time not set yet / lost (no battery?). Use: t <epoch>");
  }
  const DateTime t = datetime::fromEpoch(now.value);
  char detail[80];
  (void)snprintf(detail, sizeof(detail), "ticking, time %04u-%02u-%02uT%02u:%02u:%02uZ", t.year, t.month, t.day, t.hour,
           t.minute, t.second);
  return report("rtc", Verdict::Pass, detail);
}

void setRtcFromCommand(const String& arg) {
  Ds3231 rtc(gBus, i2c_addr::kRtc);
  const uint32_t epoch = static_cast<uint32_t>(strtoul(arg.c_str(), nullptr, 10));
  const Status s = (rtc.begin() == Status::Ok) ? rtc.setEpoch(epoch) : Status::DeviceMissing;
  Serial.printf("  set RTC to %lu: %s\n", static_cast<unsigned long>(epoch), statusName(s));
}

// ------------------------------------------------------------------ IMU ----

Verdict testMag(Mpu9250& imu) {
  if (!imu.hasMag()) {
    return report("mag", Verdict::Warn, "no AK8963: board is probably an MPU6500 (no compass)");
  }
  RunningStats3 field;
  for (int i = 0; i < 300 && field.count() < 20; i++) {
    const Result<Vec3> m = imu.readMag();
    if (m.ok()) {
      field.add(m.value);
    }
    delay(10);
  }
  if (field.count() < 5) {
    return report("mag", Verdict::Fail, "magnetometer gives no data");
  }
  const float b = length(field.mean());
  char detail[64];
  (void)snprintf(detail, sizeof(detail), "|B| = %.1f uT (Earth: 25-65, uncalibrated)", b);
  return report("mag", (b > 10 && b < 150) ? Verdict::Pass : Verdict::Warn, detail);
}

Verdict testImu() {
  Serial.println("\n-- MPU9250 IMU (0x69) - keep it flat and still --");
  Mpu9250 imu(gBus, gClock, i2c_addr::kImu);
  if (imu.begin() != Status::Ok) {
    const bool at68 = gBus.probe(i2c_addr::kRtc) == Status::Ok;
    return report("imu", Verdict::Fail, at68 ? "no IMU at 0x69; something at 0x68: tie AD0 to 3V3!" : "no answer at 0x69");
  }
  Serial.printf("  WHO_AM_I 0x%02X\n", imu.whoAmI());
  RunningStats3 accel, gyro;
  for (int i = 0; i < 100; i++) {
    const Result<ImuSample> s = imu.readImu();
    if (s.ok()) {
      accel.add(s.value.accelG);
      gyro.add(s.value.gyroDps);
    }
    delay(10);
  }
  const float g = length(accel.mean());
  const float noise = sqrtf(accel.variance().x + accel.variance().y + accel.variance().z);
  Serial.printf("  |accel| %.3f g, noise %.4f g, |gyro| %.2f dps\n", g, noise, length(gyro.mean()));
  if (accel.count() < 90) {
    return report("imu", Verdict::Fail, "reads keep failing");
  }
  if (noise == 0.0f) {
    return report("imu", Verdict::Fail, "values never change: sensor stuck");
  }
  const Verdict v = (g < 0.85f || g > 1.15f)          ? report("imu", Verdict::Fail, "|accel| should be ~1 g at rest")
                    : (length(gyro.mean()) > 5.0f)    ? report("imu", Verdict::Warn, "gyro offset >5 dps (moving? needs calibration)")
                                                      : report("imu", Verdict::Pass, "accel ~1 g, gyro quiet");
  const Verdict m = testMag(imu);
  return (v == Verdict::Fail || m == Verdict::Fail) ? Verdict::Fail : v;
}

// --------------------------------------------------------- 817 inputs ----

Verdict testInputs() {
  Serial.println("\n-- 817 module inputs: watching GPIO27 (CH1 alternator) and GPIO26 (CH2 pulse) for 20 s --");
  Serial.println("  Apply / remove 12-24 V on IN1 and IN2 now. LED on the module = input on = GPIO LOW.");
  pinMode(pins::kAlternator, INPUT_PULLUP);
  pinMode(pins::kPulse, INPUT_PULLUP);
  int lastAlt = -1, lastPulse = -1;
  uint32_t altEdges = 0, pulseEdges = 0;
  bool altLow = false, altHigh = false;
  const uint32_t start = millis();
  while (millis() - start < 20000) {
    const int a = digitalRead(pins::kAlternator);
    const int p = digitalRead(pins::kPulse);
    if (a != lastAlt || p != lastPulse) {
      Serial.printf("  %5.1fs  GPIO27=%s  GPIO26=%s\n", static_cast<float>(millis() - start) / 1000.0f, a ? "HIGH (off)" : "LOW (on) ",
                    p ? "HIGH (off)" : "LOW (on)");
      altEdges += (lastAlt >= 0 && a != lastAlt) ? 1 : 0;
      pulseEdges += (lastPulse >= 0 && p != lastPulse) ? 1 : 0;
    }
    altLow = altLow || a == LOW;
    altHigh = altHigh || a == HIGH;
    lastAlt = a;
    lastPulse = p;
    delay(2);
  }
  Serial.printf("  edges: CH1 %lu, CH2 %lu\n", static_cast<unsigned long>(altEdges), static_cast<unsigned long>(pulseEdges));
  if (altLow && altHigh) {
    return report("817", Verdict::Pass, "CH1 switches both ways");
  }
  return report("817", Verdict::Warn, altLow ? "CH1 stuck LOW (pull-up? jumper?)" : "CH1 never went LOW (input wiring, R4, D1 direction)");
}

void powerChecklist() {
  Serial.println("\n-- Power / LM2596 checklist (multimeter, ESP32 NOT connected) --");
  Serial.println("  1. 12 or 24 V on J4 (+ / GND). Reverse it once: nothing may get warm (D3 blocks).");
  Serial.println("  2. Voltage after D3 (VBAT_PROT) = input - ~0.4 V.");
  Serial.println("  3. Turn the LM2596 trimmer until OUT+ = 5.00 V (+-0.1 V).");
  Serial.println("  4. Load test: 100 ohm on OUT (50 mA): stays 5.0 V.");
  Serial.println("  5. Only then plug in the ESP32 and check 3V3 pin = 3.3 V.");
}

// ---------------------------------------------------------------- shell ----

void runAll() {
  const Verdict v[4] = {testScan(), testEeprom(), testRtc(), testImu()};
  const char* names[4] = {"scan", "eeprom", "rtc", "imu"};
  Serial.println("\n=== summary ===");
  for (int i = 0; i < 4; i++) {
    Serial.printf("  %-7s %s\n", names[i], verdictText(v[i]));
  }
}

void handleLine(String line) {
  line.trim();
  if (line.length() == 0) {
    return;
  }
  switch (line[0]) {
    case 's': (void)testScan(); break;
    case 'e': (void)testEeprom(); break;
    case 'r': (void)testRtc(); break;
    case 'i': (void)testImu(); break;
    case 'o': (void)testInputs(); break;
    case 'p': powerChecklist(); break;
    case 'a': runAll(); break;
    case 't': setRtcFromCommand(line.substring(1)); break;
    default: printHelp(); break;
  }
  Serial.print("\n> ");
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(500);
  (void)gBus.begin();
  printHelp();
  Serial.print("\n> ");
}

void loop() {
  static String line;
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      handleLine(line);
      line = "";
    } else if (line.length() < 40) {
      line += c;
    }
  }
}
