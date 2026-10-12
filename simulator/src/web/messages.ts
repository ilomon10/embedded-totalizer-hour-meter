// messages.ts: what the simulator and its web UI say to each other over the
// WebSocket at /api/ws. Shared by src/web/server.ts and web/src (type-only imports,
// so the browser bundle pulls in no simulator code).
import type { SimSnapshot } from '../device.ts';
import type { FaultSettings } from '../faults.ts';
import type { Group, InputValues } from '../inputs.ts';

export type { FaultSettings, Group, InputValues, SimSnapshot };
export type { Inputs, Mode } from '../inputs.ts';
export type { DeviceStatus, HourMeterSnapshot, Settings, Vec3 } from '../frames.ts';

export type ModuleName = 'eeprom' | 'rtc' | 'imu' | 'mag';
export type PowerAction = 'power-cycle' | 'watchdog' | 'reboot';

/** One line in the frame log. */
export interface LogEntry {
  id: number;
  /** Wall clock, ms since 1970. */
  atMs: number;
  /** tx = device -> host, rx = host -> device, info = sessions and errors. */
  dir: 'tx' | 'rx' | 'info';
  /** TELEMETRY, EVENT, ACK, IMU, COMMAND, or a short word for info lines. */
  type: string;
  seq?: number;
  text: string;
  records?: [string, string][];
  /** tx only: false when nobody received it (no client, Bluetooth locked, output setting). */
  delivered?: boolean;
}

export interface SimState extends SimSnapshot {
  version: string;
  deviceId: number;
  transport: string;
  clientConnected: boolean;
  faults: FaultSettings;
}

export type ServerMessage = { type: 'state'; state: SimState } | { type: 'log'; entries: LogEntry[] };

export type ClientMessage =
  | { [G in Group]: { type: 'set'; group: G; patch: Partial<InputValues[G]> } }[Group]
  | { type: 'auto'; group: Group }
  | { type: 'counters'; runSeconds?: number; totalCount?: number }
  | { type: 'module'; module: ModuleName; fitted: boolean }
  | { type: 'faults'; patch: Partial<FaultSettings> }
  | { type: 'power'; action: PowerAction }
  | { type: 'calibration'; flags: number };
