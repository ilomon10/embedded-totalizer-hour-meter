// server.ts: the simulator's web UI. Serves the React app from web/dist and a
// WebSocket at /api/ws: state 5 times a second and the frame log to the page,
// control messages from it (see messages.ts).
//
// It binds to 127.0.0.1 unless --web-host says otherwise. There is no login:
// anyone who can reach the port can drive the simulated device.
import { Device, type Message } from '../protocol.ts';
import { LastCause, ResetReason, type SimDevice, Stage } from '../device.ts';
import type { Faults } from '../faults.ts';
import { GROUPS } from '../inputs.ts';
import { msgName, recordPairs } from '../log.ts';
import { VehicleSim } from '../vehicle/sim.ts';
import type { DecodedMessage } from '../protocol.ts';
import type { ClientMessage, LogEntry, ModuleName, ServerMessage, SimState } from './messages.ts';

const PUSH_MS = 100; // 10 Hz: smooth enough for the moving vehicle
const HISTORY = 500;
const DIST = new URL('../../web/dist/', import.meta.url);
const MODULE_BIT: Record<ModuleName, number> = {
  eeprom: Device.eeprom,
  rtc: Device.rtc,
  imu: Device.imu,
  mag: Device.mag,
};
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export interface WebContext {
  device: SimDevice;
  faults: Faults;
  /** the device's clock (live controls are timed against it) */
  nowMs: () => number;
  random: () => number;
  version: string;
  deviceId: number;
  transport: { label: string; connected(): boolean };
}

/** Apply one message from the page. Returns an error text for nonsense input. */
export function applyClientMessage(msg: ClientMessage, ctx: WebContext): string | null {
  const { device } = ctx;
  switch (msg.type) {
    case 'set':
      if (!GROUPS.includes(msg.group)) return `unknown group ${msg.group}`;
      device.setInput(msg.group, msg.patch as never);
      return null;
    case 'auto':
      if (!GROUPS.includes(msg.group)) return `unknown group ${msg.group}`;
      device.setAutoInput(msg.group);
      return null;
    case 'counters': {
      const run = msg.runSeconds === undefined ? null : Math.round(msg.runSeconds);
      const count = msg.totalCount === undefined ? null : Math.round(msg.totalCount);
      const bad = (v: number | null) => v !== null && !(v >= 0 && v <= 0xffffffff);
      if (bad(run) || bad(count)) return 'counters must be 0..4294967295';
      device.presetCounters(run, count);
      return null;
    }
    case 'module': {
      const bit = MODULE_BIT[msg.module];
      if (bit === undefined) return `unknown module ${msg.module}`;
      device.setFitted(bit, msg.fitted);
      return null;
    }
    case 'faults':
      ctx.faults.set(msg.patch);
      return null;
    case 'power':
      if (msg.action === 'power-cycle') device.powerOn();
      else if (msg.action === 'panic') device.panicSignal();
      else if (msg.action === 'hang') device.hang();
      else if (msg.action === 'watchdog') device.reset(ResetReason.taskWatchdog, LastCause.watchdog, Stage.imu);
      else device.reset(ResetReason.software, LastCause.rebootCommand, Stage.serial);
      return null;
    case 'calibration':
      device.setCalibrationFlags(msg.flags & 3);
      return null;
    case 'vehicle': {
      if (msg.kind === null) {
        device.attachVehicle(null);
        return null;
      }
      if (msg.kind !== 'truck' && msg.kind !== 'plane') return `unknown vehicle ${msg.kind}`;
      const origin = msg.origin ?? device.vehicle()?.frame.origin;
      if (!origin || !(Math.abs(origin.lat) <= 85) || !(Math.abs(origin.lon) <= 180)) return 'vehicle needs an origin';
      const previous = device.vehicle();
      const sim = new VehicleSim({ kind: msg.kind, origin, headingDeg: msg.headingDeg ?? 0, random: ctx.random });
      const plan = previous?.snapshot().route;
      if (plan && !msg.origin) sim.setRoute(plan); // same place, other vehicle: keep the route
      device.attachVehicle(sim);
      return null;
    }
    default:
      return applyDriveMessage(msg, ctx);
  }
}

/** Messages that need a vehicle. */
function applyDriveMessage(msg: ClientMessage, ctx: WebContext): string | null {
  const sim = ctx.device.vehicle();
  if (!sim) return 'no vehicle: start one first';
  switch (msg.type) {
    case 'route':
      sim.setRoute(msg.plan && msg.plan.waypoints.length >= 2 ? msg.plan : null);
      return null;
    case 'play':
      if (msg.action === 'play') sim.play();
      else if (msg.action === 'pause') sim.pause();
      else sim.stop();
      return null;
    case 'drive-mode':
      sim.setMode(msg.mode);
      return null;
    case 'controls': {
      const c = msg.controls;
      const num = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v) || 0));
      sim.setLive({
        throttle: num(c.throttle, 0, 1),
        brake: num(c.brake, 0, 1),
        steer: num(c.steer, -1, 1),
        pitch: num(c.pitch, -1, 1),
        reverse: c.reverse === true,
      }, ctx.nowMs());
      return null;
    }
    case 'anchor':
      sim.anchor();
      return null;
    case 'estimator':
      sim.setHeadingSource(msg.headingSource === 'compass' ? 'compass' : 'gyro');
      return null;
    case 'clear-tracks':
      sim.clearTracks();
      return null;
    case 'mount': {
      const m = msg.mount ?? {};
      const deg = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v) || 0));
      sim.setMount({
        yawDeg: ((deg(m.yawDeg, -360, 360) % 360) + 360) % 360,
        pitchDeg: deg(m.pitchDeg, -30, 30),
        rollDeg: deg(m.rollDeg, -30, 30),
      });
      return null;
    }
    case 'mount-cal':
      if (msg.step !== 'level' && msg.step !== 'front' && msg.step !== 'clear') return `unknown step ${msg.step}`;
      sim.calibrateMount(msg.step);
      return null;
    default:
      return 'unknown message';
  }
}

/** Collects log lines and pushes state + log to every open page. */
export class WebHub {
  private readonly sockets = new Set<WebSocket>();
  private history: LogEntry[] = [];
  private pending: LogEntry[] = [];
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private trackOf: VehicleSim | null = null;
  private trackCursor = 0;
  private trackResets = -1;

  constructor(private readonly ctx: WebContext) {}

  state(): SimState {
    return {
      ...this.ctx.device.snapshot(),
      vehicle: this.ctx.device.vehicle()?.snapshot() ?? null,
      version: this.ctx.version,
      deviceId: this.ctx.deviceId,
      transport: this.ctx.transport.label,
      clientConnected: this.ctx.transport.connected(),
      faults: this.ctx.faults.get(),
    };
  }

  info(type: string, text: string): void {
    this.add({ dir: 'info', type, text });
  }

  sent(msg: Message & { seq: number }, delivered: boolean): void {
    this.add({
      dir: 'tx',
      type: msgName(msg.msgType),
      seq: msg.seq,
      text: '',
      records: recordPairs(msg.records),
      delivered,
    });
  }

  received(cmd: DecodedMessage): void {
    const records = recordPairs(cmd.records.map((r) => ({ tag: r.tag, value: r.raw })));
    this.add({ dir: 'rx', type: msgName(cmd.msgType), seq: cmd.seq, text: '', records });
  }

  attach(socket: WebSocket): void {
    socket.onopen = () => {
      this.sockets.add(socket);
      this.sendTo(socket, { type: 'log', entries: this.history });
      const sim = this.ctx.device.vehicle();
      if (sim) this.sendTo(socket, { type: 'track', points: sim.trackSince(0, -2).points, reset: true });
      this.sendTo(socket, { type: 'state', state: this.state() });
    };
    socket.onclose = () => this.sockets.delete(socket);
    socket.onerror = () => this.sockets.delete(socket);
    socket.onmessage = (event) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return this.info('error', 'web UI sent invalid JSON');
      }
      const error = applyClientMessage(msg, this.ctx);
      if (error) this.info('error', `web UI: ${error}`);
      this.sendTo(socket, { type: 'state', state: this.state() }); // answer at once, not at the next tick
    };
  }

  start(): void {
    this.timer = setInterval(() => this.push(), PUSH_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const socket of this.sockets) socket.close();
  }

  private add(entry: Omit<LogEntry, 'id' | 'atMs'>): void {
    const full: LogEntry = { id: this.nextId++, atMs: Date.now(), ...entry };
    this.pending.push(full);
    this.history.push(full);
    if (this.history.length > HISTORY) this.history = this.history.slice(-HISTORY);
  }

  private push(): void {
    if (this.sockets.size === 0) {
      this.pending = [];
      return;
    }
    const log: ServerMessage = { type: 'log', entries: this.pending };
    const state: ServerMessage = { type: 'state', state: this.state() };
    const track = this.trackUpdate();
    this.pending = [];
    for (const socket of this.sockets) {
      if (log.entries.length) this.sendTo(socket, log);
      if (track) this.sendTo(socket, track);
      this.sendTo(socket, state);
    }
  }

  /** New track points since the last push; a new vehicle or cleared tracks start over. */
  private trackUpdate(): ServerMessage | null {
    const sim = this.ctx.device.vehicle();
    if (sim !== this.trackOf) {
      this.trackOf = sim;
      this.trackCursor = 0;
      this.trackResets = -1;
      if (!sim) return { type: 'track', points: [], reset: true };
    }
    if (!sim) return null;
    const t = sim.trackSince(this.trackCursor, this.trackResets);
    const first = this.trackResets === -1;
    this.trackCursor = t.cursor;
    this.trackResets = t.resets;
    if (!t.reset && !first && t.points.length === 0) return null;
    return { type: 'track', points: t.points, reset: t.reset || first };
  }

  private sendTo(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }
}

async function staticFile(pathname: string): Promise<Response> {
  const clean = pathname.replace(/^\/+/, '').replace(/\.\.+/g, '');
  for (const candidate of [clean || 'index.html', 'index.html']) { // unknown paths: the SPA
    try {
      const body = await Deno.readFile(new URL(candidate, DIST));
      const ext = candidate.slice(candidate.lastIndexOf('.'));
      return new Response(body, { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream' } });
    } catch {
      // try the next candidate
    }
  }
  return new Response('The web UI is not built yet: run `deno task web:build` in simulator/, then restart.\n', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Start the web UI. Resolves with its URL once it listens; `close()` stops it. */
export function startWebServer(
  hub: WebHub,
  { port, hostname }: { port: number; hostname: string },
): { url: string; close(): Promise<void> } {
  const server = Deno.serve({ port, hostname, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/ws') {
      if (req.headers.get('upgrade') !== 'websocket') return new Response('WebSocket only', { status: 426 });
      const { socket, response } = Deno.upgradeWebSocket(req);
      hub.attach(socket);
      return response;
    }
    if (url.pathname === '/api/state') return Response.json(hub.state());
    return staticFile(url.pathname);
  });
  hub.start();
  const addr = server.addr as Deno.NetAddr;
  const shownHost = addr.hostname === '0.0.0.0' ? 'localhost' : addr.hostname;
  return {
    url: `http://${shownHost}:${addr.port}/`,
    close: async () => {
      hub.stop();
      await server.shutdown();
    },
  };
}
