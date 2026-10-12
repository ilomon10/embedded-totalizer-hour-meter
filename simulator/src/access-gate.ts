// access-gate.ts: PIN lock for Bluetooth sessions, a port of esp32/lib/App/src/AccessGate.h.
//
// A Bluetooth session starts LOCKED: the device answers every command with
// Locked (9) and sends no live data until COMMAND unlock=<PIN> succeeds. A wrong
// PIN answers BadPin (10); after 5 wrong PINs every unlock is refused (Locked)
// for 60 s. Wired ports (USB, UART pins) are never locked.
import { Ack } from './protocol.ts';

export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 60_000;

export class AccessGate {
  private isUnlocked = false;
  private lockedOut = false;
  private failures = 0;
  private lockoutUntilMs = 0;

  unlocked(): boolean {
    return this.isUnlocked;
  }

  /** New client or disconnect: lock again. The failure count survives, like the firmware. */
  lock(): void {
    this.isUnlocked = false;
  }

  /** Returns an ackStatus: Ok unlocks, BadPin counts a failure, Locked during a lockout. */
  tryUnlock(pin: number, expectedPin: number, nowMs: number): number {
    if (this.lockedOut && nowMs < this.lockoutUntilMs) return Ack.Locked;
    this.lockedOut = false;
    if (pin === expectedPin) {
      this.isUnlocked = true;
      this.failures = 0;
      return Ack.Ok;
    }
    this.failures++;
    if (this.failures >= MAX_FAILURES) {
      this.failures = 0;
      this.lockedOut = true;
      this.lockoutUntilMs = nowMs + LOCKOUT_MS;
    }
    return Ack.BadPin;
  }
}
