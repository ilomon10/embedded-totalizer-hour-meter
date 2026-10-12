// clock.ts: time source injected into the simulated device (like the firmware's IClock),
// so tests can step time exactly instead of sleeping.

export interface Clock {
  /** Milliseconds since an arbitrary start; never goes backwards. */
  nowMs(): number;
  /** Host wall clock, UTC Unix seconds. Plays the part of a battery-backed RTC. */
  hostEpochS(): number;
}

export const realClock: Clock = {
  nowMs: () => performance.now(),
  hostEpochS: () => Math.floor(Date.now() / 1000),
};

export class FakeClock implements Clock {
  constructor(private ms = 0, private epochS = 1791376496) {} // 2026-10-07T12:34:56Z

  nowMs(): number {
    return this.ms;
  }

  hostEpochS(): number {
    return this.epochS + Math.floor(this.ms / 1000);
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Small seeded PRNG (mulberry32) so runs with the same --seed are repeatable. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
