// controls.ts: keyboard and gamepad -> {throttle, brake, steer, pitch} (+ the reverse gear,
// a toggle kept by the page: X on the keyboard, a gamepad button).
//
// Keyboard keys are digital, so they ramp (a key held for 0.4 s gives full throttle):
// stepped inputs would make step-shaped accelerations, which no real driver produces.
// Gamepads are analog and read through a remappable binding table kept in localStorage.
import type { Controls } from '../../../src/web/messages.ts';

export type Action = 'throttle' | 'brake' | 'steer' | 'pitch' | 'reverse' | 'anchor';

export interface Binding {
  kind: 'axis' | 'button';
  index: number;
  invert: boolean;
  /** 0..0.5: inputs below this count as 0 */
  deadzone: number;
}

export type Mapping = Record<Action, Binding | null>;

export const ACTIONS: { action: Action; label: string; hint: string }[] = [
  { action: 'throttle', label: 'Throttle', hint: '0 to full' },
  { action: 'brake', label: 'Brake', hint: '0 to full' },
  { action: 'steer', label: 'Steer', hint: 'left to right (plane: bank)' },
  { action: 'pitch', label: 'Climb', hint: 'plane only: up = climb' },
  { action: 'reverse', label: 'Reverse', hint: 'truck only, a button: toggle drive / reverse' },
  { action: 'anchor', label: 'GPS fix', hint: 'a button: re-anchor the estimate' },
];

/** The standard gamepad layout (Xbox/PlayStation in a browser): triggers drive, left stick steers. */
export const DEFAULT_MAPPING: Mapping = {
  throttle: { kind: 'button', index: 7, invert: false, deadzone: 0.05 }, // right trigger
  brake: { kind: 'button', index: 6, invert: false, deadzone: 0.05 }, // left trigger
  steer: { kind: 'axis', index: 0, invert: false, deadzone: 0.08 }, // left stick x
  pitch: { kind: 'axis', index: 1, invert: true, deadzone: 0.08 }, // left stick y (up is negative)
  reverse: { kind: 'button', index: 1, invert: false, deadzone: 0.5 }, // B / circle
  anchor: { kind: 'button', index: 0, invert: false, deadzone: 0.5 }, // A / cross
};

const STORAGE_KEY = 'hour-meter-sim.gamepad-mapping';

export function loadMapping(): Mapping {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return saved ? { ...DEFAULT_MAPPING, ...saved } : DEFAULT_MAPPING;
  } catch {
    return DEFAULT_MAPPING;
  }
}

export function saveMapping(m: Mapping): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
  } catch {
    // private window or storage blocked: the mapping lasts for this visit
  }
}

export function describeBinding(b: Binding | null): string {
  if (!b) return 'not set';
  return `${b.kind === 'axis' ? 'Axis' : 'Button'} ${b.index}${b.invert ? ', inverted' : ''}`;
}

/** Read one binding from a pad: -1..1 for axes, 0..1 for buttons, dead zone applied. */
export function readBinding(pad: Gamepad, b: Binding | null): number {
  if (!b) return 0;
  const raw = b.kind === 'axis' ? pad.axes[b.index] ?? 0 : pad.buttons[b.index]?.value ?? 0;
  const v = b.invert ? -raw : raw;
  if (Math.abs(v) < b.deadzone) return 0;
  return Math.sign(v) * (Math.abs(v) - b.deadzone) / (1 - b.deadzone);
}

/** The first input that moves well away from its resting value: used by "Assign". */
export function detectInput(pad: Gamepad, rest: { axes: number[]; buttons: number[] }): Binding | null {
  for (let i = 0; i < pad.buttons.length; i++) {
    if ((pad.buttons[i]?.value ?? 0) - (rest.buttons[i] ?? 0) > 0.5) {
      return { kind: 'button', index: i, invert: false, deadzone: 0.05 };
    }
  }
  for (let i = 0; i < pad.axes.length; i++) {
    const d = (pad.axes[i] ?? 0) - (rest.axes[i] ?? 0);
    if (Math.abs(d) > 0.6) return { kind: 'axis', index: i, invert: d < 0, deadzone: 0.08 };
  }
  return null;
}

export function firstPad(): Gamepad | null {
  return navigator.getGamepads?.().find((p) => p && p.connected) ?? null;
}

const RAMP_PER_S = 2.5; // keyboard: 0 -> 1 in 0.4 s

/** Keyboard state -> smooth controls. Call `step(dt)` every frame. */
export class KeyboardDriver {
  private down = new Set<string>();
  private c: Controls = { throttle: 0, brake: 0, steer: 0, pitch: 0 };

  key(code: string, pressed: boolean): boolean {
    const known = [
      'KeyW',
      'KeyS',
      'KeyA',
      'KeyD',
      'KeyQ',
      'KeyE',
      'Space',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
    ];
    if (!known.includes(code)) return false;
    if (pressed) this.down.add(code);
    else this.down.delete(code);
    return true;
  }

  active(): boolean {
    return this.down.size > 0 || Object.values(this.c).some((v) => Math.abs(v) > 0.01);
  }

  step(dt: number): Controls {
    const has = (...codes: string[]) => codes.some((c) => this.down.has(c));
    const toward = (v: number, target: number) => {
      const d = target - v;
      return v + Math.sign(d) * Math.min(Math.abs(d), RAMP_PER_S * dt);
    };
    this.c = {
      throttle: toward(this.c.throttle, has('KeyW', 'ArrowUp') ? 1 : 0),
      brake: toward(this.c.brake, has('KeyS', 'ArrowDown', 'Space') ? 1 : 0),
      steer: toward(this.c.steer, (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0)),
      pitch: toward(this.c.pitch, (has('KeyQ') ? 1 : 0) - (has('KeyE') ? 1 : 0)),
    };
    return this.c;
  }
}
