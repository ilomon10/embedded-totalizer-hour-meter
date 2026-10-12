/// @file SensorFrame.h
/// SensorFrame: compact TLV sensor frames with CRC16 and COBS framing.
/// Wire format: see SPEC.md in the SensorFrame repository.
///
/// Include this one header. Everything is header-only, heap-free and works on
/// ESP32, ESP8266, RP2040, STM32, AVR and desktop C++ (unit tests).
#pragma once

#include "SensorFrameReader.h"
#include "SensorFrameWriter.h"
#include "sf_cobs.h"
#include "sf_crc.h"
#include "sf_types.h"

#if defined(ESP32)
#include <Esp.h>
/// Stable 32-bit device id: bytes 2..5 of the factory MAC (unique per chip).
static inline uint32_t sf_device_id() { return (uint32_t)(ESP.getEfuseMac() >> 16); }
#elif defined(ESP8266)
#include <Esp.h>
static inline uint32_t sf_device_id() { return ESP.getChipId(); }
#endif
