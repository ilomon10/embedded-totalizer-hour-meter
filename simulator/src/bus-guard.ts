// bus-guard.ts: when to stop using the I2C bus, and when to try it again.
// Port of esp32/lib/App/src/BusGuard.h (firmware 2.7.0).
//
// Every I2C module (EEPROM, RTC, IMU) is optional, so a bad bus is never a reason to restart. The bus is PARKED
// instead: every module counts as missing. It is tried again after a pause that doubles each time the bus is
// still bad (10 s, 20 s, 40 s ... 5 min), and starts again at 10 s once the bus has worked for 10 minutes.
//
//   park when: transfers kept failing (timeouts / bus errors, never a NACK) for PARK_AFTER_MS,
//              or a bus recovery found SDA or SCL still held low.
export const PARK_AFTER_MS = 5000;
export const FIRST_PAUSE_MS = 10_000;
export const MAX_PAUSE_MS = 300_000; // 5 min
export const HEALTHY_MS = 600_000; // in use this long: the next pause is FIRST_PAUSE_MS again

function doubled(ms: number): number {
  return ms >= MAX_PAUSE_MS / 2 ? MAX_PAUSE_MS : ms * 2;
}

export class BusGuard {
  private isParkedNow = false;
  private everParked = false;
  private failingActive = false;
  private failingSinceMs = 0;
  private parkedAtMs = 0;
  private inUseSinceMs = 0;
  private pause = FIRST_PAUSE_MS;

  /** Call every poll while the bus is in use. True when it must be parked now. */
  shouldPark(nowMs: number, failing: boolean, lineHeldLow: boolean): boolean {
    if (lineHeldLow) return true; // no transfer can work until the module or short is removed
    if (!failing) {
      this.failingActive = false;
      return false;
    }
    if (!this.failingActive) {
      this.failingActive = true;
      this.failingSinceMs = nowMs;
    }
    return nowMs - this.failingSinceMs >= PARK_AFTER_MS;
  }

  /** The bus was parked: by shouldPark(), or because starting it found a line held low. */
  parked(nowMs: number): void {
    const soonAgain = this.everParked && nowMs - this.inUseSinceMs < HEALTHY_MS;
    this.pause = soonAgain ? doubled(this.pause) : FIRST_PAUSE_MS;
    this.everParked = true;
    this.isParkedNow = true;
    this.parkedAtMs = nowMs;
    this.failingActive = false;
  }

  isParked(): boolean {
    return this.isParkedNow;
  }

  /** While parked: time to start the bus again? */
  retryDue(nowMs: number): boolean {
    return this.isParkedNow && nowMs - this.parkedAtMs >= this.pause;
  }

  /** The retry found a line still held low: stay parked, wait twice as long. */
  retryFailed(nowMs: number): void {
    this.pause = doubled(this.pause);
    this.parkedAtMs = nowMs;
  }

  /** The retry found both lines free: the bus is in use again (the presence check re-attaches the modules). */
  resumed(nowMs: number): void {
    this.isParkedNow = false;
    this.inUseSinceMs = nowMs;
    this.failingActive = false;
  }

  /** As at boot (the `i2c` setting was switched): no pause history. */
  reset(): void {
    Object.assign(this, new BusGuard());
  }

  pauseMs(): number {
    return this.pause;
  }
}
