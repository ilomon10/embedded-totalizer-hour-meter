// scenarios.ts: fault injection, so driver authors can test the unhappy paths
// they would otherwise only meet in the field.
//
//   --scenario <name>[=args]   (repeatable)
//
// A scenario can change the device before power-on (configure), act on it over
// time (tick), or set the starting wire faults (faults, see faults.ts). Randomness
// comes from the seeded RNG, so a run with the same --seed fails the same way.
import type { DeviceOptions, SimDevice } from './device.ts';
import type { FaultSettings } from './faults.ts';
import { LastCause, ResetReason, Stage } from './device.ts';
import { Device } from './protocol.ts';

export interface Scenario {
  label: string;
  configure?(opts: DeviceOptions): void;
  tick?(nowMs: number, dev: SimDevice): void;
  faults?: Partial<FaultSettings>;
}

type Factory = (args: string[], random: () => number) => Scenario;

const MODULE_BITS: Record<string, number> = {
  eeprom: Device.eeprom,
  rtc: Device.rtc,
  imu: Device.imu,
  mag: Device.mag,
};

function num(value: string | undefined, fallback: number, what: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what}: expected a positive number, got '${value}'`);
  return n;
}

function moduleBit(name: string): number {
  const bit = MODULE_BITS[name];
  if (bit === undefined) throw new Error(`unknown module '${name}' (use: ${Object.keys(MODULE_BITS).join(', ')})`);
  return bit;
}

/** Module absent from power-on: the matching *Missing flag is set and its tags disappear. */
const absent = (module: string): Factory => () => ({
  label: `no ${module}`,
  configure: (opts) => {
    opts.fitted &= ~moduleBit(module);
    if (module === 'imu') opts.fitted &= ~Device.mag; // the magnetometer is inside the MPU9250
  },
});

const SCENARIOS: Record<string, { help: string; make: Factory }> = {
  'engine-cycle': {
    help: 'engine-cycle[=onS,offS]  alternator on/off cycle (default 40,40); the default when --engine is not given',
    make: ([on, off]) => {
      const onMs = num(on, 40, 'engine-cycle on') * 1000;
      const offMs = num(off, 40, 'engine-cycle off') * 1000;
      return {
        label: `engine ${onMs / 1000} s on / ${offMs / 1000} s off`,
        tick: (nowMs, dev) => dev.setEngine(nowMs % (onMs + offMs) < onMs),
      };
    },
  },
  'acc-wire': {
    help:
      'acc-wire                 engine input wired to the key (ON from the start) but the engine runs only 20-80 s of ' +
      'each 120 s, vibration 8-12 mg off / 40-80 mg on: run hours grow all the time until hour-meter set runVibMinMg=30',
    make: () => ({
      label: 'engine input on with the key; engine runs 20-80 s of every 120 s',
      tick: (nowMs, dev) => {
        const t = nowMs % 120_000;
        const running = t >= 20_000 && t < 80_000;
        dev.setEngine(true); // the key is on
        dev.setVibrationRange(running ? [40, 80] : [8, 12]);
      },
    }),
  },
  'no-rtc-battery': {
    help: 'no-rtc-battery           RTC lost its time at power-on: timeValid=false, rtcBatteryLost until setTime',
    make: () => ({ label: 'RTC without battery', configure: (opts) => void (opts.rtcBattery = false) }),
  },
  'no-eeprom': {
    help: 'no-eeprom                no EEPROM: counters in RAM only, presets answer DeviceMissing',
    make: absent('eeprom'),
  },
  'no-rtc': {
    help: 'no-rtc                   no RTC: time invalid until setTime, then timeNotBackedUp',
    make: absent('rtc'),
  },
  'no-imu': {
    help: 'no-imu                   no MPU9250: no roll/pitch/heading/vibration, no IMU stream',
    make: absent('imu'),
  },
  'no-mag': { help: 'no-mag                   IMU without magnetometer: no heading, no mag axes', make: absent('mag') },
  'module-flap': {
    help: 'module-flap[=module,periodS]  unplug/replug a module every period (default imu,30) -> EVENT kind 3',
    make: ([module, period]) => {
      const name = module || 'imu';
      const bit = moduleBit(name);
      const periodMs = num(period, 30, 'module-flap period') * 1000;
      let next = periodMs;
      return {
        label: `${name} unplugged/replugged every ${periodMs / 1000} s`,
        tick: (nowMs, dev) => {
          if (nowMs < next) return;
          next = nowMs + periodMs;
          dev.setFitted(bit, !dev.isFitted(bit));
        },
      };
    },
  },
  'reboot': {
    help:
      'reboot[=periodS]         watchdog reset every period (default 120) -> boot EVENT, resetReason 6, lastCause 1, lastStage 7',
    make: ([period]) => {
      const periodMs = num(period, 120, 'reboot period') * 1000;
      let next = periodMs;
      return {
        label: `watchdog reset every ${periodMs / 1000} s`,
        tick: (nowMs, dev) => {
          if (nowMs < next) return;
          next = nowMs + periodMs;
          dev.reset(ResetReason.taskWatchdog, LastCause.watchdog, Stage.imu);
        },
      };
    },
  },
  'hang': {
    help: 'hang[=afterS]            frozen MCU after afterS (default 30): sends nothing, ignores commands; ' +
      'only the panic signal (64 zero bytes) or a restart from the web UI ends it',
    make: ([after]) => {
      const afterMs = num(after, 30, 'hang after') * 1000;
      let done = false;
      return {
        label: `device freezes after ${afterMs / 1000} s`,
        tick: (nowMs, dev) => {
          if (done || nowMs < afterMs) return;
          done = true;
          dev.hang();
        },
      };
    },
  },
  'safe-mode': {
    help: 'safe-mode               boots as after 3 unplanned restarts: no I2C (devices 0, all *Missing flags + ' +
      'safeMode), counting in RAM, no IMU stream; lastCause 1, lastStage 7; a power cycle, reboot or the panic signal leaves it',
    make: () => ({
      label: 'safe mode (no I2C)',
      configure: (opts) => {
        opts.safeMode = true;
        opts.firstBoot = { reason: ResetReason.taskWatchdog, cause: LastCause.watchdog, stage: Stage.imu };
      },
    }),
  },
  'noise': {
    help: 'noise[=probability]      random junk bytes (zeros included) before some frames (default 0.2)',
    make: ([p]) => {
      const noise = Math.min(1, num(p, 0.2, 'noise probability'));
      return { label: `line noise before ${Math.round(noise * 100)} % of frames`, faults: { noise } };
    },
  },
  'corrupt': {
    help: 'corrupt[=N]              flip one byte in 1 of every N frames (default 10) -> CRC errors',
    make: ([n]) => {
      const corruptEvery = Math.round(num(n, 10, 'corrupt N'));
      return { label: `1 in ${corruptEvery} frames corrupted`, faults: { corruptEvery } };
    },
  },
};

/** Parse `name[=a,b]`. Throws with the list of valid names on a typo. */
export function parseScenario(spec: string, random: () => number): Scenario {
  const [name, rawArgs = ''] = spec.split('=', 2);
  const entry = SCENARIOS[name];
  if (!entry) throw new Error(`unknown scenario '${name}'\n${scenarioHelp()}`);
  return entry.make(rawArgs.split(','), random);
}

export function scenarioHelp(): string {
  return Object.values(SCENARIOS).map((s) => `  ${s.help}`).join('\n');
}
