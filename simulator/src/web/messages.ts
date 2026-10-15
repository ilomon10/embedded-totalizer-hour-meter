// messages.ts: what the simulator and its web UI say to each other over the
// WebSocket at /api/ws. Shared by src/web/server.ts and web/src (type-only imports,
// so the browser bundle pulls in no simulator code).
import type { SimSnapshot } from '../device.ts';
import type { FaultSettings } from '../faults.ts';
import type { Group, InputValues } from '../inputs.ts';
import type { Mount } from '../vehicle/body.ts';
import type { HeadingSource } from '../vehicle/dead-reckoning.ts';
import type { MountCalStatus, MountCalStep } from '../vehicle/mount-cal.ts';
import type { LatLon } from '../vehicle/geo.ts';
import type { Controls, VehicleKind } from '../vehicle/models.ts';
import type { RoutePlan, Waypoint } from '../vehicle/route.ts';
import type { DriveMode, TrackPoint, VehicleSnapshot } from '../vehicle/sim.ts';

export type { FaultSettings, Group, InputValues, SimSnapshot };
export type {
  Controls,
  DriveMode,
  HeadingSource,
  LatLon,
  Mount,
  MountCalStatus,
  MountCalStep,
  RoutePlan,
  TrackPoint,
  VehicleKind,
  VehicleSnapshot,
  Waypoint,
};
export type { Inputs, Mode } from '../inputs.ts';
export type { DeviceStatus, HourMeterSnapshot, Settings, Vec3 } from '../frames.ts';

export type ModuleName = 'eeprom' | 'rtc' | 'imu' | 'mag';
export type PowerAction = 'power-cycle' | 'watchdog' | 'reboot' | 'panic' | 'hang';

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
  /** null while no vehicle drives the device (Panels/Bench behaviour). */
  vehicle: VehicleSnapshot | null;
}

export type ServerMessage =
  | { type: 'state'; state: SimState }
  | { type: 'log'; entries: LogEntry[] }
  /** New track points (truth + estimate). `reset`: drop what you have first. */
  | { type: 'track'; points: TrackPoint[]; reset: boolean };

export type ClientMessage =
  | { [G in Group]: { type: 'set'; group: G; patch: Partial<InputValues[G]> } }[Group]
  | { type: 'auto'; group: Group }
  | { type: 'counters'; runSeconds?: number; totalCount?: number }
  | { type: 'module'; module: ModuleName; fitted: boolean }
  | { type: 'faults'; patch: Partial<FaultSettings> }
  | { type: 'power'; action: PowerAction }
  | { type: 'calibration'; flags: number }
  /** Start a vehicle at `origin` (kind null = stop driving, back to the animation). */
  | { type: 'vehicle'; kind: VehicleKind | null; origin?: LatLon; headingDeg?: number }
  | { type: 'route'; plan: RoutePlan | null }
  | { type: 'play'; action: 'play' | 'pause' | 'stop' }
  | { type: 'drive-mode'; mode: DriveMode }
  /** Live driving: send about 20 times a second; the vehicle brakes after 500 ms without. */
  | { type: 'controls'; controls: Controls }
  /** A simulated GPS fix: the estimate jumps to the truth. */
  | { type: 'anchor' }
  | { type: 'estimator'; headingSource: HeadingSource }
  | { type: 'clear-tracks' }
  /** How the board is fitted in the truck (degrees; all 0 = x forward, z up). */
  | { type: 'mount'; mount: Mount }
  /** Mounting calibration: level (vehicle still), then front (drive straight ahead), or clear. */
  | { type: 'mount-cal'; step: MountCalStep };
