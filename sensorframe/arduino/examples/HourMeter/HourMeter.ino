// HourMeter: engine run-hours (alternator signal) + pulse totalizer.
// Sends a TELEMETRY frame every second over Serial (or RS485 via Serial2).
#include <SensorFrame.h>

enum : uint8_t {
  TAG_RUN_SECONDS = 1,  // u32  seconds the alternator signal was HIGH
  TAG_TOTAL_COUNT = 2,  // u32  pulses counted on PULSE_PIN
  TAG_ALTERNATOR = 3,   // bool alternator signal right now
};

const int ALTERNATOR_PIN = 27;
const int PULSE_PIN = 26;
const uint32_t REPORT_MS = 1000;

volatile uint32_t pulseCount = 0;
uint32_t runSeconds = 0;
uint32_t runMsRemainder = 0;
uint32_t lastTick = 0;
uint16_t seq = 0;
SensorFrameWriter<64> frame;  // 12 header + 15 records + 2 CRC fits easily

#if defined(ESP32)
void IRAM_ATTR onPulse() { pulseCount++; }
#else
void onPulse() { pulseCount++; }
#endif

uint32_t deviceId() {
#if defined(ESP32) || defined(ESP8266)
  return sf_device_id();
#else
  return 1;
#endif
}

void setup() {
  Serial.begin(115200);
  pinMode(ALTERNATOR_PIN, INPUT);
  pinMode(PULSE_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PULSE_PIN), onPulse, FALLING);
  lastTick = millis();
}

void loop() {
  uint32_t now = millis();
  if (now - lastTick < REPORT_MS) return;
  uint32_t elapsed = now - lastTick;
  lastTick = now;

  bool running = digitalRead(ALTERNATOR_PIN) == HIGH;
  if (running) {
    runMsRemainder += elapsed;
    runSeconds += runMsRemainder / 1000;
    runMsRemainder %= 1000;
  }

  noInterrupts();
  uint32_t count = pulseCount;
  interrupts();

  frame.begin(SF_MSG_TELEMETRY, seq++, deviceId(), now / 1000);
  frame.addU32(TAG_RUN_SECONDS, runSeconds);
  frame.addU32(TAG_TOTAL_COUNT, count);
  frame.addBool(TAG_ALTERNATOR, running);
  frame.send(Serial);
}
