// SerialLink.cpp — see header.
#include "SerialLink.h"

void SerialLink::beginUsb(uint32_t usbBaud) {
  // Software buffers (must be set before begin): without them the TX side is
  // only the 128-byte hardware FIFO and bursts of frames would be dropped.
  (void)usb_.setRxBufferSize(kRxBufferSize);
  (void)usb_.setTxBufferSize(kTxBufferSize);
  usb_.begin(usbBaud);
  usbReader_.onFrame(onFrame, &usbCtx_);
  usbReader_.onError(onError, &usbCtx_);
}

void SerialLink::beginUart(uint32_t uartBaud, int uartRx, int uartTx, OutputPort output) {
  uartRx_ = uartRx;
  uartTx_ = uartTx;
  (void)uart_.setRxBufferSize(kRxBufferSize);
  (void)uart_.setTxBufferSize(kTxBufferSize);
  // ESP32 core takes pins as int8_t; BoardPins values are small GPIO numbers.
  uart_.begin(uartBaud, SERIAL_8N1, static_cast<int8_t>(uartRx_), static_cast<int8_t>(uartTx_));
  uartBaud_ = uartBaud;
  output_ = output;
  uartReader_.onFrame(onFrame, &uartCtx_);
  uartReader_.onError(onError, &uartCtx_);
  btReader_.onFrame(onFrame, &btCtx_);
  btReader_.onError(onError, &btCtx_);
}

bool SerialLink::startBluetooth(const char* deviceName) {
  if (btOn_) {
    return true;
  }
  btOn_ = bt_.begin(deviceName);  // SSP "just works" pairing; access is PIN-locked in the protocol
  btTelemetry_ = false;
  btReader_.reset();
  return btOn_;
}

void SerialLink::stopBluetooth() {
  if (!btOn_) {
    return;
  }
  bt_.end();
  btOn_ = false;
  btTelemetry_ = false;
}

void SerialLink::reconfigure(uint32_t uartBaud, OutputPort output) {
  output_ = output;
  if (uartBaud != uartBaud_) {
    uart_.flush();
    uart_.updateBaudRate(uartBaud);
    uartBaud_ = uartBaud;
    uartReader_.reset();
  }
}

void SerialLink::onCommand(CommandHandlerFn fn, void* ctx) {
  handler_ = fn;
  handlerCtx_ = ctx;
}

void SerialLink::poll() {
  pollWired(usb_, usbReader_, usbPanic_);
  if (uartBaud_ != 0) {
    pollWired(uart_, uartReader_, uartPanic_);
  }
  if (btOn_) {
    (void)btReader_.poll(bt_);
  }
}

// Like SensorFrameReader::poll, but every byte also goes past the panic detector.
// Bounded by the RX buffer size so one poll can never run forever.
void SerialLink::pollWired(HardwareSerial& s, SensorFrameReader<SF_MAX_PACKET>& reader, PanicDetector& panic) {
  for (size_t i = 0; i < kRxBufferSize && s.available() > 0; i++) {
    const int c = s.read();
    if (c < 0) {
      break;
    }
    const uint8_t b = static_cast<uint8_t>(c);
    if (panic.feed(b)) {
      panic_ = true;
    }
    (void)reader.feed(b);
  }
}

void SerialLink::onFrame(SensorFrameView& frame, void* ctx) {
  ReaderCtx* c = static_cast<ReaderCtx*>(ctx);
  if (c->link->handler_ != nullptr) {
    c->link->handler_(frame, c->port, c->link->handlerCtx_);
  }
}

void SerialLink::onError(SfError, void* ctx) { static_cast<ReaderCtx*>(ctx)->link->dropped_++; }

void SerialLink::sendTelemetry(FrameWriter& w) {
  if (output_ == OutputPort::Usb || output_ == OutputPort::Both) {
    sendTo(Port::Usb, w);
  }
  if (output_ == OutputPort::Uart || output_ == OutputPort::Both) {
    sendTo(Port::Uart, w);
  }
  if (btTelemetry_) {
    sendTo(Port::Bluetooth, w);
  }
}

void SerialLink::sendTo(Port port, FrameWriter& w) {
  uint8_t frame[SF_COBS_MAX(SF_MAX_PACKET) + 1];
  const size_t n = w.encodeFrame(frame, sizeof(frame));
  if (n == 0) {
    dropped_++;
    return;
  }
  if (port == Port::Bluetooth) {
    // SPP queues internally (32 packets); only write while someone listens.
    if (!bluetoothClient()) {
      dropped_++;
      return;
    }
    (void)bt_.write(frame, n);
    return;
  }
  HardwareSerial& s = (port == Port::Usb) ? usb_ : uart_;
  // Never block the loop on a full TX buffer: drop the frame instead.
  const bool fits = static_cast<size_t>(s.availableForWrite()) >= n;
  if (port == Port::Usb) {
    usbBlocked_ = !fits;
  }
  if (!fits) {
    dropped_++;
    return;
  }
  (void)s.write(frame, n);
}

void SerialLink::flush() {
  usb_.flush();
  uart_.flush();
  if (bluetoothClient()) {
    bt_.flush();
  }
}
