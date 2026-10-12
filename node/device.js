// DeviceClient: talk to the hour meter over a serial port.
//
//   const dev = await DeviceClient.open('/dev/ttyUSB0');
//   const ack = await dev.request({ get: 1 });   // resolves with the ACK message
//   dev.on('frame', (msg) => ...);                // every TELEMETRY / IMU / EVENT frame
//
// request() implements the protocol rules: unique seq per command, wait for
// the ACK whose ackSeq matches, retry with the SAME seq on timeout.
const { EventEmitter } = require('events');
const { createCodec, FrameStream } = require('sensorframe');
const { tags, MSG, ACK_STATUS } = require('./tags');

const codec = createCodec({ tags });
const TIME_INVALID_BIT = 1 << 2; // statusFlags bit 2 (see tags.js STATUS_FLAGS)

class DeviceClient extends EventEmitter {
  /** @param {import('stream').Duplex} port any duplex byte stream (SerialPort, socket, test double) */
  constructor(port) {
    super();
    this.port = port;
    this.seq = Math.floor(Math.random() * 0xffff);
    this.pending = new Map(); // seq -> resolve
    port.pipe(new FrameStream({ codec }))
      .on('data', (msg) => this._onFrame(msg))
      .on('frameError', (err) => this.emit('frameError', err));
  }

  /**
   * Open a serial port and wait until the device talks (ESP32 boards reboot when the port opens).
   * Works the same for USB, a USB-TTL adapter on the UART pins, or Bluetooth SPP
   * (/dev/rfcomm0 on Linux, the "Standard Serial over Bluetooth" COM port on Windows).
   * Pass `pin` for Bluetooth: the session is locked until unlocked with the device PIN.
   * @param {string} path
   * @param {{ baudRate?: number, readyTimeoutMs?: number, pin?: string | number }} [options]
   */
  static async open(path, { baudRate = 115200, readyTimeoutMs = 4000, pin } = {}) {
    const { SerialPort } = require('serialport');
    const port = new SerialPort({ path, baudRate });
    await new Promise((resolve, reject) => port.once('open', resolve).once('error', reject));
    const dev = new DeviceClient(port);
    if (pin !== undefined) await dev.unlock(pin);  // a locked Bluetooth session sends nothing until then
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, readyTimeoutMs); // silent device (output=uart): just go on
      dev.once('frame', () => { clearTimeout(timer); resolve(); });
    });
    return dev;
  }

  /**
   * Send one COMMAND and resolve with its ACK. Rejects if the device answers
   * with a non-Ok ackStatus or never answers.
   * @param {Record<string, number|boolean>} values tag names from tags.js
   */
  async request(values, { timeoutMs = 1500, retries = 2 } = {}) {
    const seq = this.seq = (this.seq + 1) & 0xffff;
    const bytes = codec.frame({ msgType: MSG.COMMAND, seq, values });
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ack = await this._sendAndWait(seq, bytes, timeoutMs);
      if (!ack) continue; // timeout: resend the same seq (device answers duplicates again)
      const status = ack.values.ackStatus;
      if (status !== 0) {
        const rejected = ack.values.rejectedTag ? ` (tag ${ack.values.rejectedTag}: ${tags[ack.values.rejectedTag]?.name ?? '?'})` : '';
        const err = new Error(`device answered ${ACK_STATUS[status] ?? status}${rejected}`);
        err.ack = ack;
        throw err;
      }
      return ack;
    }
    throw new Error(`no ACK after ${retries + 1} attempts`);
  }

  /** Unlock a Bluetooth session (harmless on USB/UART). Rejects with BadPin / Locked. */
  unlock(pin) {
    return this.request({ unlock: Number(pin) });
  }

  /** Resolve with the next EVENT of a kind (e.g. calibration finished). */
  waitForEvent(kind, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off('frame', onFrame); reject(new Error('timeout waiting for event')); }, timeoutMs);
      const onFrame = (msg) => {
        if (msg.msgType === MSG.EVENT && msg.values.eventKind === kind) {
          clearTimeout(timer);
          this.off('frame', onFrame);
          resolve(msg);
        }
      };
      this.on('frame', onFrame);
    });
  }

  /**
   * Keep the device clock set: whenever a frame says the time is unknown
   * (timeValid=false, e.g. the RTC has no backup battery and power was cut),
   * send the PC clock as UTC. Rate-limited so a silent failure cannot flood the link.
   * Emits 'timeSynced' (epoch) or 'timeSyncError' (Error).
   */
  enableAutoTimeSync({ minIntervalMs = 30000, now = () => Date.now() } = {}) {
    let lastAttempt = -Infinity;
    let busy = false;
    this.on('frame', async (msg) => {
      const flags = msg.values.statusFlags;
      const timeUnknown = msg.values.timeValid === false || (flags !== undefined && (flags & TIME_INVALID_BIT) !== 0);
      if (!timeUnknown || busy || now() - lastAttempt < minIntervalMs) return;
      busy = true;
      lastAttempt = now();
      const epoch = Math.floor(now() / 1000);
      try {
        await this.request({ setTime: epoch });
        this.emit('timeSynced', epoch);
      } catch (err) {
        this.emit('timeSyncError', err);
      } finally {
        busy = false;
      }
    });
    return this;
  }

  close() { this.port.close?.() ?? this.port.end(); }

  _sendAndWait(seq, bytes, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(seq); resolve(null); }, timeoutMs);
      this.pending.set(seq, (ack) => { clearTimeout(timer); this.pending.delete(seq); resolve(ack); });
      this.port.write(bytes);
    });
  }

  _onFrame(msg) {
    if (msg.msgType === MSG.ACK && this.pending.has(msg.values.ackSeq)) {
      this.pending.get(msg.values.ackSeq)(msg);
      return;
    }
    this.emit('frame', msg);
  }
}

module.exports = { DeviceClient, codec };
