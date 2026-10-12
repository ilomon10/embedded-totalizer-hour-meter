// CommandHandler.h — turns one COMMAND frame into actions + one ACK frame.
//
// Rules (also in docs/INTEGRATION-GUIDE.md):
//  1. Validate EVERYTHING first. Any unknown tag or invalid value -> ACK error,
//     and NOTHING is applied (all-or-nothing, like a DB transaction).
//  2. Apply settings (persisted to EEPROM), then actions in frame order.
//  3. If the frame contains `get`, the requested data is appended to the ACK.
//  4. Every COMMAND gets exactly one ACK echoing its seq (ackSeq).
#pragma once

#include "IDeviceControl.h"
#include "Protocol.h"

struct CommandResult {
  AckStatus status = AckStatus::Ok;
  uint8_t rejectedTag = 0;   // tag that caused the error (0 = none)
  bool settingsChanged = false;
};

class CommandHandler {
 public:
  explicit CommandHandler(IDeviceControl& device) : device_(device) {}

  // Handle `cmd` and write the ACK into `ack` (ready to send).
  CommandResult handle(SensorFrameView& cmd, FrameWriter& ack, uint16_t ackFrameSeq, uint32_t deviceId);

 private:
  IDeviceControl& device_;

  CommandResult validate(SensorFrameView& cmd, Settings& next, bool& hasSettings) const;
  CommandResult runActions(SensorFrameView& cmd);
  CommandResult runAction(const SensorFrameRecord& r);
  void appendRequested(SensorFrameView& cmd, FrameWriter& ack) const;
};

// Map a firmware Status onto the ackStatus the host sees.
AckStatus toAckStatus(Status s);

// Start an ACK frame: header + ackSeq + ackStatus (+ rejectedTag when non-zero).
// Data requested with `get` is appended after this by the caller.
void buildAck(FrameWriter& ack, uint16_t ackFrameSeq, uint32_t deviceId, const DeviceStatus& st, uint16_t cmdSeq,
              AckStatus status, uint8_t rejectedTag);
