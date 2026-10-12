// BasicSerial: send three sensor values once per second over Serial.
// Decode on the PC with:  node examples/serial-reader.js /dev/ttyUSB0
#include <SensorFrame.h>

// Tag table: keep in sync with the `tags` object on the Node.js side.
enum : uint8_t {
  TAG_UPTIME = 1,   // u32, seconds
  TAG_ANALOG = 2,   // u16, raw ADC
  TAG_BUTTON = 3,   // bool
};

const int ANALOG_PIN = A0;
const int BUTTON_PIN = 0;

SensorFrameWriter<> frame;  // 128-byte buffer on the stack/BSS, no heap
uint16_t seq = 0;

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
}

void loop() {
  uint32_t now = millis() / 1000;
  frame.begin(SF_MSG_TELEMETRY, seq++, 1, now);  // deviceId 1
  frame.addU32(TAG_UPTIME, now);
  frame.addU16(TAG_ANALOG, analogRead(ANALOG_PIN));
  frame.addBool(TAG_BUTTON, digitalRead(BUTTON_PIN) == LOW);
  frame.send(Serial);  // COBS + 0x00 delimiter
  delay(1000);
}
