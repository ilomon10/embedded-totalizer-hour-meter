// connection.ts: one device the TUI talks to, kept open across USB unplugs, Bluetooth drops and restarts of a
// TCP bridge.
//
//   const conn = new Connection({ target, open, timeSync: true });
//   conn.on('client', (dev) => ...);   // a DeviceClient: at the start and after every reconnect
//   conn.on('state', (s) => ...);      // connecting / connected / waiting (with the reason) / paused / closed
//   conn.start();                      // open now; until it opens, try again every second
//
// When the link closes underneath (the board was unplugged: its port reads EOF or an error) or the port file
// disappears (checked every second, for systems where the read only blocks), the client is dropped and the
// port is opened again until it works. The board is found again by its adapter id (Linux /dev/serial/by-id), so
// it still connects when it comes back as /dev/ttyUSB1. pause() hands the port to the flasher; resume() takes
// the flasher's client back, or reconnects.
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';

import type { Target } from './cli.ts';
import type { DeviceClient } from './device.ts';
import { errorCode } from './platform.ts';
import { findAgain, openProblem, type PortInfo } from './ports.ts';
import { isLocalSerial } from './reset.ts';

export type ConnState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  /** Not open: `problem` says why (unplugged, not there, no permission). Tried again every `retryMs`. */
  | { kind: 'waiting'; problem: string; sinceMs: number; lost: boolean }
  /** The flasher has the port. */
  | { kind: 'paused' }
  | { kind: 'closed' };

export interface ConnectionOptions {
  target: Target;
  /** Open the target and wait for the device (cli.ts connect()). */
  open: (target: Target) => Promise<DeviceClient>;
  /** Already open (the connect screen opened it): no first attempt. */
  client?: DeviceClient;
  /** Answer the device's "what time is it" with the PC clock. */
  timeSync?: boolean;
  /** The serial ports now, to find a replugged board under a new name. */
  ports?: () => Promise<PortInfo[]>;
  /** Is the port file still there (a gone file means unplugged even if the read never ends). */
  present?: (path: string) => Promise<boolean>;
  /** The adapter id of the port (from the connect screen's listing). */
  portId?: string;
  retryMs?: number;
  now?: () => number;
  /** Plain words for a failed open (ports.ts openProblem()). */
  problem?: (err: unknown, spec: string) => Promise<string>;
}

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

export class Connection extends EventEmitter {
  client?: DeviceClient;
  state: ConnState = { kind: 'connecting' };
  /** The port in use: can change when a replugged board comes back under another name. */
  port: string;
  private portId?: string;
  private retry?: ReturnType<typeof setTimeout>;
  private watch?: ReturnType<typeof setInterval>;
  private attempting?: Promise<void>; // an open in flight
  private generation = 0; // bumped by pause() and close(): an attempt from before them must not adopt or retry
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ConnectionOptions) {
    super();
    this.port = options.target.port;
    this.portId = options.portId;
    this.retryMs = options.retryMs ?? 1000;
    this.now = options.now ?? Date.now;
    if (options.client) this.adopt(options.client);
  }

  get demo(): boolean {
    return this.options.target.demo;
  }

  get target(): Target {
    return { ...this.options.target, port: this.port };
  }

  /** Open the port; keep trying until it opens. Nothing to do when the client was given. */
  start(): this {
    if (!this.client) void this.attempt();
    return this;
  }

  /**
   * Close the client and stop watching: the flasher needs the port. Resolves when an open still in flight has
   * settled (and closed what it opened), so nothing touches the port's lines while the flasher has it.
   */
  async pause(): Promise<void> {
    this.release();
    this.setState({ kind: 'paused' });
    await this.attempting;
  }

  /** After a flash: take the flasher's client, or open the port again (until it opens). */
  resume(client?: DeviceClient): void {
    if (this.state.kind !== 'paused') {
      client?.close(); // closed meanwhile: nobody takes this client
      return;
    }
    if (client) this.adopt(client);
    else {
      this.setState({
        kind: 'waiting',
        problem: 'the board did not come back after the flash',
        sinceMs: this.now(),
        lost: true,
      });
      this.schedule();
    }
  }

  /** A Bluetooth PIN that worked: reconnects unlock with it too. */
  rememberPin(pin: string): void {
    this.options.target.pin = pin;
  }

  /** For good: close the client, stop retrying. */
  close(): void {
    this.release();
    this.setState({ kind: 'closed' });
  }

  /** Drop the client and stop the timers; attempts started before this are void. */
  private release(): void {
    this.generation++;
    this.stopTimers();
    const dev = this.client;
    this.client = undefined;
    dev?.close();
  }

  private setState(state: ConnState): void {
    this.state = state;
    this.emit('state', state);
  }

  private adopt(dev: DeviceClient): void {
    clearInterval(this.watch);
    this.client = dev;
    if (this.options.timeSync) dev.enableAutoTimeSync();
    dev.once('close', () => this.lost(dev, 'the board was disconnected'));
    this.setState({ kind: 'connected' });
    this.emit('client', dev);
    if (isLocalSerial(this.port, this.demo)) {
      const present = this.options.present ?? exists;
      this.watch = setInterval(async () => {
        if (this.client === dev && !(await present(this.port))) {
          this.lost(dev, 'the board was unplugged');
        }
      }, this.retryMs);
    }
  }

  /** The link of `dev` closed, or its port is gone. Only the client in use counts (not one closed on purpose). */
  private lost(dev: DeviceClient, problem: string): void {
    if (this.client !== dev) return;
    this.stopTimers();
    this.client = undefined;
    dev.close();
    this.setState({ kind: 'waiting', problem, sinceMs: this.now(), lost: true });
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.attempt(), this.retryMs);
  }

  private attempt(): Promise<void> {
    if (this.attempting || this.client || this.stopped()) return this.attempting ?? Promise.resolve();
    this.attempting = this.tryOpen(this.generation).finally(() => (this.attempting = undefined));
    return this.attempting;
  }

  private async tryOpen(generation: number): Promise<void> {
    const stale = () => generation !== this.generation || this.client !== undefined;
    try {
      if (this.options.ports && isLocalSerial(this.port, this.demo)) {
        const again = findAgain(await this.options.ports().catch(() => []), this.port, this.portId);
        if (again) {
          this.port = again.path;
          this.portId = again.id ?? this.portId;
        }
      }
      const dev = await this.options.open(this.target);
      if (stale()) {
        dev.close(); // paused, closed, or another client came meanwhile
        return;
      }
      this.adopt(dev);
    } catch (err) {
      if (stale()) return;
      const problem = await (this.options.problem ?? openProblem)(err, this.port);
      if (stale()) return; // paused or closed while the words were found
      const previous = this.state;
      // An unplug stays the reason shown while the port is missing; a new reason (e.g. no permission) replaces it.
      const keep = previous.kind === 'waiting' && previous.lost && errorCode(err) === 'ENOENT';
      this.setState({
        kind: 'waiting',
        problem: keep ? previous.problem : problem,
        sinceMs: previous.kind === 'waiting' ? previous.sinceMs : this.now(),
        lost: previous.kind === 'waiting' ? previous.lost : false,
      });
      this.schedule();
    }
  }

  /** Paused for a flash, or closed: no attempts. */
  private stopped(): boolean {
    return this.state.kind === 'paused' || this.state.kind === 'closed';
  }

  private stopTimers(): void {
    clearTimeout(this.retry);
    clearInterval(this.watch);
    this.retry = undefined;
    this.watch = undefined;
  }
}
