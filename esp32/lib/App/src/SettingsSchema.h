// SettingsSchema.h — the ONE table of configurable settings: tag, name, wire
// format and allowed range. Used to validate commands, to answer `get settings`
// and (via scripts/check-docs.ts) to keep docs + the host tag table in sync.
//
// TS mental model:
//   const settingsSchema = [{ tag: 110, name: 'telemetryIntervalMs', fmt: 'u16', min: 100, max: 60000 }, ...] as const;
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "Protocol.h"
#include "Settings.h"

struct SettingSpec {
  uint8_t tag;
  const char* name;
  uint8_t fmt;  // SF_U8 / SF_U16 / SF_U32 / SF_BOOL / SF_F32
  double min;
  double max;
};

namespace settings_schema {

extern const SettingSpec kSpecs[];
extern const size_t kCount;

const SettingSpec* find(uint8_t tag);

// Current value of a setting as a number.
double read(const Settings& s, uint8_t tag);

// Store a value that already passed checkValue(). Returns false for unknown tags.
bool write(Settings& s, uint8_t tag, double value);

// Validate one incoming record against its spec. On success `out` holds the value.
AckStatus checkValue(const SettingSpec& spec, const SensorFrameRecord& rec, double& out);

// Rules that involve several settings at once (e.g. stream rate <= sample rate).
// Returns the tag of the first violated setting, or 0 if all good.
uint8_t checkCrossField(const Settings& s);

// Append every setting (for `get settings`). False if the frame is full.
bool appendAll(FrameWriter& w, const Settings& s);

// Append calibration values (for `get calibration`). False if the frame is full.
bool appendCalibration(FrameWriter& w, const Calibration& c);

}  // namespace settings_schema
