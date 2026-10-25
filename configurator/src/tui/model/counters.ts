// counters.ts: setting and resetting the hour meter and the totalizer, as a reviewable plan: what it is now, what it
// will be, the change, and the one command. An empty or invalid value is an error, never 0; a reset needs RESET
// typed. Pure.
import { hoursToSeconds, RESET_MAGIC, unitsToPulses } from '../../tags.ts';

export type CounterAction = 'hours' | 'units' | 'pulses' | 'resetHours' | 'resetTotal' | 'resetBoth';

export interface CounterInfo {
  id: CounterAction;
  label: string;
  title: string;
  /** Resets ask for the word RESET instead of a value. */
  reset: boolean;
}

export const COUNTER_ACTIONS: readonly CounterInfo[] = Object.freeze([
  { id: 'hours', label: 'Set hour meter…', title: 'Set hour meter', reset: false },
  { id: 'units', label: 'Set totalizer in units…', title: 'Set totalizer (units)', reset: false },
  { id: 'pulses', label: 'Set totalizer in pulses…', title: 'Set totalizer (pulses)', reset: false },
  { id: 'resetHours', label: 'Reset hour meter to 0…', title: 'Reset hour meter to 0', reset: true },
  { id: 'resetTotal', label: 'Reset totalizer to 0…', title: 'Reset totalizer to 0', reset: true },
  { id: 'resetBoth', label: 'Reset both to 0…', title: 'Reset hour meter and totalizer to 0', reset: true },
]);

export function counterInfo(id: CounterAction): CounterInfo {
  return COUNTER_ACTIONS.find((a) => a.id === id)!;
}

export interface CounterNow {
  runSeconds?: number;
  totalCount?: number;
  /** The device's setting; 1 until it was read. */
  pulsesPerUnit: number;
}

export interface CounterPlan {
  command: Record<string, number>;
  /** "1250.03 h" */
  now: string;
  next: string;
  /** "+60.47 h", "−378 pulses" */
  change: string;
  /** For the log: "hour meter 1250.03 → 1310.50 h". */
  logText: string;
}

const U32_MAX = 0xffffffff;
const hoursText = (seconds: number | undefined) => (seconds === undefined ? '?' : (seconds / 3600).toFixed(2));
const unitsText = (count: number | undefined, ppu: number) => (count === undefined ? '?' : (count / ppu).toFixed(2));

function signed(delta: number, digits: number): string {
  const text = Math.abs(delta).toFixed(digits);
  return delta < 0 ? `−${text}` : `+${text}`;
}

/** What the dialog asks for. */
export function counterPrompt(id: CounterAction, now: CounterNow): string {
  switch (id) {
    case 'hours':
      return 'hours, e.g. 1310.5';
    case 'units':
      return `units, e.g. 5230.75 (${now.pulsesPerUnit} pulse${now.pulsesPerUnit === 1 ? '' : 's'} per unit)`;
    case 'pulses':
      return 'pulses, a whole number';
    default:
      return 'type RESET to confirm';
  }
}

/** Turn what was typed into the change it makes, or say why it cannot be applied. */
export function planCounter(id: CounterAction, input: string, now: CounterNow): { plan?: CounterPlan; error?: string } {
  const text = input.trim();
  const ppu = now.pulsesPerUnit;
  const hNow = hoursText(now.runSeconds);
  const uNow = unitsText(now.totalCount, ppu);
  if (counterInfo(id).reset) {
    if (text !== 'RESET') return { error: text === '' ? 'type RESET to confirm' : 'type RESET (capitals) to confirm' };
    if (id === 'resetHours') {
      return {
        plan: {
          command: { setRunSeconds: 0 },
          now: `${hNow} h`,
          next: '0.00 h',
          change: now.runSeconds === undefined ? '' : signed(-now.runSeconds / 3600, 2) + ' h',
          logText: `hour meter ${hNow} → 0.00 h`,
        },
      };
    }
    if (id === 'resetTotal') {
      return {
        plan: {
          command: { setTotalCount: 0 },
          now: `${uNow} units`,
          next: '0.00 units',
          change: now.totalCount === undefined ? '' : `${signed(-now.totalCount, 0)} pulses`,
          logText: `totalizer ${now.totalCount ?? '?'} → 0 pulses`,
        },
      };
    }
    return {
      plan: {
        command: { resetCounters: RESET_MAGIC },
        now: `${hNow} h, ${uNow} units`,
        next: '0.00 h, 0.00 units',
        change: 'both to 0',
        logText: `hour meter ${hNow} h and totalizer ${now.totalCount ?? '?'} pulses → 0`,
      },
    };
  }
  if (text === '') return { error: `enter the new value in ${counterPrompt(id, now)}` };
  try {
    if (id === 'hours') {
      const seconds = hoursToSeconds(text);
      return {
        plan: {
          command: { setRunSeconds: seconds },
          now: `${hNow} h`,
          next: `${hoursText(seconds)} h`,
          change: now.runSeconds === undefined ? '' : `${signed((seconds - now.runSeconds) / 3600, 2)} h`,
          logText: `hour meter ${hNow} → ${hoursText(seconds)} h`,
        },
      };
    }
    const pulses = id === 'units' ? unitsToPulses(text, ppu) : Number(text);
    if (id === 'pulses' && (!Number.isInteger(pulses) || pulses < 0)) return { error: 'a whole number of pulses ≥ 0' };
    if (pulses > U32_MAX) return { error: `at most ${U32_MAX} pulses` };
    return {
      plan: {
        command: { setTotalCount: pulses },
        now: id === 'units' ? `${uNow} units` : `${now.totalCount ?? '?'} pulses`,
        next: id === 'units' ? `${(pulses / ppu).toFixed(2)} units` : `${pulses} pulses`,
        change: now.totalCount === undefined ? '' : `${signed(pulses - now.totalCount, 0)} pulses`,
        logText: `totalizer ${now.totalCount ?? '?'} → ${pulses} pulses`,
      },
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
