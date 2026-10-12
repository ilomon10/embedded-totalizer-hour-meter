// Bidirectional: receive COMMAND frames from Node.js and answer with an ACK.
// Node side: node examples/send-command.js /dev/ttyUSB0
#include <SensorFrame.h>

enum : uint8_t {
  TAG_COUNTER = 2,          // u32  value we report
  TAG_CMD_SET_COUNTER = 100 // u32  COMMAND: set the counter to this value
};

SensorFrameReader<> reader;
SensorFrameWriter<> out;
uint32_t counter = 0;
uint16_t seq = 0;
uint32_t lastReport = 0;

void sendAck(uint16_t ackSeq, uint8_t status) {
  out.begin(SF_MSG_ACK, seq++, 1, millis() / 1000);
  out.addU16(SF_TAG_ACK_SEQ, ackSeq);
  out.addU8(SF_TAG_ACK_STATUS, status);
  out.send(Serial);
}

void onFrame(SensorFrameView& f, void*) {
  if (f.msgType() != SF_MSG_COMMAND) return;
  SensorFrameRecord r;
  if (f.find(TAG_CMD_SET_COUNTER, r)) {
    counter = r.asU32();
    sendAck(f.seq(), 0);  // 0 = OK
  } else {
    sendAck(f.seq(), 1);  // 1 = unknown command
  }
}

void setup() {
  Serial.begin(115200);
  reader.onFrame(onFrame);
}

void loop() {
  reader.poll(Serial);  // non-blocking, call often

  if (millis() - lastReport >= 1000) {
    lastReport = millis();
    counter++;
    out.begin(SF_MSG_TELEMETRY, seq++, 1, lastReport / 1000);
    out.addU32(TAG_COUNTER, counter);
    out.send(Serial);
  }
}
