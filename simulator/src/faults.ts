// faults.ts: damage on the wire, adjustable while running.
//
//   noise         probability (0..1) of junk bytes (zeros included) before a frame
//   corruptEvery  flip one byte in 1 of every N frames (0 = off)
//
// --scenario noise=… / corrupt=… set the starting values; the web UI changes them live.
// Randomness comes from the seeded RNG, so a run with the same --seed fails the same way.

export interface FaultSettings {
  noise: number;
  corruptEvery: number;
}

export class Faults {
  private settings: FaultSettings = { noise: 0, corruptEvery: 0 };

  constructor(private readonly random: () => number) {}

  get(): FaultSettings {
    return { ...this.settings };
  }

  set(patch: Partial<FaultSettings>): void {
    const next = { ...this.settings, ...patch };
    this.settings = {
      noise: Math.min(1, Math.max(0, Number(next.noise) || 0)),
      corruptEvery: Math.max(0, Math.round(Number(next.corruptEvery) || 0)),
    };
  }

  /** The bytes that actually go on the wire for one frame. */
  mangle(frame: Uint8Array): Uint8Array {
    return this.addNoise(this.corrupt(frame));
  }

  private corrupt(frame: Uint8Array): Uint8Array {
    const every = this.settings.corruptEvery;
    if (every === 0 || frame.length < 2 || this.random() * every >= 1) return frame;
    const out = frame.slice();
    const at = Math.floor(this.random() * (out.length - 1)); // never the trailing 0x00
    out[at] ^= 1 + Math.floor(this.random() * 255);
    return out;
  }

  private addNoise(frame: Uint8Array): Uint8Array {
    if (this.settings.noise === 0 || this.random() >= this.settings.noise) return frame;
    const junk = Uint8Array.from({ length: 1 + Math.floor(this.random() * 16) }, () => Math.floor(this.random() * 256));
    const out = new Uint8Array(junk.length + frame.length);
    out.set(junk);
    out.set(frame, junk.length);
    return out;
  }
}
