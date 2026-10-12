// SerialLink.h — the three links speaking SensorFrame: USB, UART pins, Bluetooth SPP.
//
//  - Commands are accepted on every link (Bluetooth only after unlock, see AccessGate).
//  - Replies (ACK) go back to the link the command came from.
//  - Telemetry goes to the wired port(s) chosen by the `output` setting, and to
//    Bluetooth while an unlocked client is connected.
//  - The wired ports also watch for the panic signal (kPanicZeroRun 0x00 bytes in
//    a row, see Supervisor.h): no frame, no ACK, the application just restarts.
//    Not on Bluetooth: an unauthenticated restart over the air is not allowed.
#pragma once

#include <Arduino.h>
#include <BluetoothSerial.h>

#include "Protocol.h"
#include "Settings.h"
#include "Supervisor.h"

enum class Port : uint8_t { Usb = 1, Uart = 2, Bluetooth = 3 };
constexpr size_t kPortCount = 3;
inline size_t portIndex(Port p) { return static_cast<size_t>(p) - 1; }

class SerialLink {
 public:
  static constexpr size_t kRxBufferSize = 1024;
  static constexpr size_t kTxBufferSize = 2048;

  typedef void (*CommandHandlerFn)(SensorFrameView& frame, Port from, void* ctx);

  SerialLink(HardwareSerial& usb, HardwareSerial& uart) : usb_(usb), uart_(uart) {}

  // USB first (fixed baud, needs no settings) so it is up before any I2C work;
  // the UART pins once the settings are known.
  void beginUsb(uint32_t usbBaud);
  void beginUart(uint32_t uartBaud, int uartRx, int uartTx, OutputPort output);
  void reconfigure(uint32_t uartBaud, OutputPort output);
  void onCommand(CommandHandlerFn fn, void* ctx);

  // Bluetooth SPP (Classic). Takes ~1 s to start; the radio is off until then.
  bool startBluetooth(const char* deviceName);
  void stopBluetooth();
  bool bluetoothOn() const { return btOn_; }
  bool bluetoothClient() { return btOn_ && bt_.hasClient(); }
  // Telemetry over Bluetooth only once the session is unlocked.
  void setBluetoothTelemetry(bool enabled) { btTelemetry_ = enabled; }

  // Read everything available on all links; dispatch complete frames.
  void poll();

  void sendTelemetry(FrameWriter& w);
  void sendTo(Port port, FrameWriter& w);
  void flush();

  uint32_t droppedFrames() const { return dropped_; }

  // A wired port received the panic signal.
  bool panicRequested() const { return panic_; }
  // The last frame for USB found its TX buffer full, and none has fitted since.
  bool usbTxBlocked() const { return usbBlocked_; }

 private:
  struct ReaderCtx {
    SerialLink* link;
    Port port;
  };

  HardwareSerial& usb_;
  HardwareSerial& uart_;
  BluetoothSerial bt_;
  bool btOn_ = false;
  bool btTelemetry_ = false;
  int uartRx_ = -1;
  int uartTx_ = -1;
  uint32_t uartBaud_ = 0;
  OutputPort output_ = OutputPort::Usb;
  SensorFrameReader<SF_MAX_PACKET> usbReader_;
  SensorFrameReader<SF_MAX_PACKET> uartReader_;
  SensorFrameReader<SF_MAX_PACKET> btReader_;
  ReaderCtx usbCtx_{this, Port::Usb};
  ReaderCtx uartCtx_{this, Port::Uart};
  ReaderCtx btCtx_{this, Port::Bluetooth};
  CommandHandlerFn handler_ = nullptr;
  void* handlerCtx_ = nullptr;
  uint32_t dropped_ = 0;
  PanicDetector usbPanic_;
  PanicDetector uartPanic_;
  bool panic_ = false;
  bool usbBlocked_ = false;

  void pollWired(HardwareSerial& s, SensorFrameReader<SF_MAX_PACKET>& reader, PanicDetector& panic);
  static void onFrame(SensorFrameView& frame, void* ctx);
  static void onError(SfError err, void* ctx);
};
