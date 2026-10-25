// connection.test.ts: the TUI's link to the device across unplugs, missing ports and a firmware flash, with
// fake ports: each "board" is a DeviceClient over an in-memory link pair, unplugged by closing its far end.
import { test } from 'bun:test';

import { assert, assertEquals, sysError } from './assert.ts';
import type { Target } from '../src/cli.ts';
import { Connection, type ConnectionOptions, type ConnState } from '../src/connection.ts';
import { DeviceClient } from '../src/device.ts';
import { type Link, linkPair } from '../src/links.ts';
import { errorCode } from '../src/platform.ts';
import type { PortInfo } from '../src/ports.ts';

interface Board {
  dev: DeviceClient;
  unplug: () => void;
}

function board(): Board {
  const [host, device]: [Link, Link] = linkPair();
  return { dev: new DeviceClient(host), unplug: () => device.close() };
}

/** `answers` in turn: a board, or an error to throw. Records every target opened. */
function fakeOpen(answers: Array<Board | Error>) {
  const opened: Target[] = [];
  const open = (target: Target) => {
    opened.push(target);
    const next = answers.shift();
    if (!next) return Promise.reject(sysError('ENOENT', 'no more boards'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.dev);
  };
  return { open, opened };
}

async function until(what: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function connection(options: Partial<ConnectionOptions> & Pick<ConnectionOptions, 'open'>) {
  const states: ConnState[] = [];
  const clients: DeviceClient[] = [];
  const conn = new Connection({
    target: { demo: false, port: '/dev/ttyUSB0' },
    retryMs: 10,
    present: () => Promise.resolve(true),
    problem: (err) => Promise.resolve(errorCode(err) ?? (err as Error).message),
    ...options,
  });
  conn.on('state', (s: ConnState) => states.push(s));
  conn.on('client', (d: DeviceClient) => clients.push(d));
  return { conn, states, clients };
}

test('an unplugged board is waited for and connected again', async () => {
  const first = board(),
    second = board();
  const { open } = fakeOpen([sysError('ENOENT', 'gone'), second]);
  const { conn, states, clients } = connection({ open, client: first.dev });
  assertEquals(conn.state.kind, 'connected');
  first.unplug();
  await until(() => clients.length === 1);
  assertEquals(clients[0], second.dev);
  const waiting = states.find((s) => s.kind === 'waiting');
  assert(waiting?.kind === 'waiting' && waiting.lost);
  // the unplug stays the reason while the port is missing
  assertEquals(
    states.filter((s) => s.kind === 'waiting').map((s) => s.kind === 'waiting' && s.problem),
    ['the board was disconnected', 'the board was disconnected'],
  );
  assertEquals(conn.state.kind, 'connected');
  conn.close();
});

test('a port that does not open yet is tried again, with the reason', async () => {
  const b = board();
  const { open, opened } = fakeOpen([sysError('EACCES', 'no'), sysError('EACCES', 'no'), b]);
  const { conn, states } = connection({ open });
  conn.start();
  await until(() => conn.state.kind === 'connected');
  assertEquals(opened.length, 3);
  const first = states[0];
  assert(first.kind === 'waiting' && first.problem === 'EACCES' && !first.lost);
  conn.close();
});

test('a board back under another name is found by its adapter id', async () => {
  const first = board(),
    second = board();
  const { open, opened } = fakeOpen([second]);
  const ports: PortInfo[] = [{ path: '/dev/ttyUSB1', label: '', kind: 'usb', id: 'usb-CP2102-0001', boardLike: true }];
  const { conn } = connection({
    open,
    client: first.dev,
    portId: 'usb-CP2102-0001',
    ports: () => Promise.resolve(ports),
  });
  first.unplug();
  await until(() => conn.state.kind === 'connected' && opened.length === 1);
  assertEquals(opened[0].port, '/dev/ttyUSB1');
  assertEquals(conn.port, '/dev/ttyUSB1');
  conn.close();
});

test('a port file that disappears counts as unplugged, even while the read still waits', async () => {
  const first = board(),
    second = board();
  let there = true;
  const { open } = fakeOpen([second]);
  const { conn, states } = connection({ open, client: first.dev, present: () => Promise.resolve(there) });
  there = false;
  await until(() => states.some((s) => s.kind === 'waiting'));
  const lost = states.find((s) => s.kind === 'waiting');
  assert(lost?.kind === 'waiting' && lost.problem === 'the board was unplugged');
  there = true;
  await until(() => conn.client === second.dev);
  conn.close();
  first.unplug();
});

test('a flash: pause closes the client without reconnecting, resume takes the flasher client', async () => {
  const first = board(),
    flashed = board();
  const { open, opened } = fakeOpen([]);
  const { conn, clients } = connection({ open, client: first.dev });
  conn.pause();
  assertEquals(conn.state.kind, 'paused');
  await new Promise((r) => setTimeout(r, 50)); // the closed client's 'close' must not start a reconnect
  assertEquals(opened.length, 0);
  conn.resume(flashed.dev);
  assertEquals(conn.state.kind, 'connected');
  assertEquals(clients, [flashed.dev]);
  conn.close();
});

test('the port did not come back after a flash: it is waited for', async () => {
  const b = board();
  const { open } = fakeOpen([b]);
  const { conn } = connection({ open, client: board().dev });
  conn.pause();
  conn.resume(undefined);
  assertEquals(conn.state.kind, 'waiting');
  await until(() => conn.client === b.dev);
  conn.close();
});

test('closed: no more attempts, and a connect that finishes late is closed', async () => {
  let release: (dev: DeviceClient) => void = () => {};
  const late = board();
  let closed = false;
  late.dev.close = () => (closed = true);
  const { conn } = connection({ open: () => new Promise((r) => (release = r)) });
  conn.start();
  conn.close();
  release(late.dev);
  await until(() => closed);
  assertEquals(conn.state.kind, 'closed');
  assertEquals(conn.client, undefined);
});

test('a reconnect still opening when a flash starts: pause waits for it, and it is never adopted', async () => {
  let release: (dev: DeviceClient) => void = () => {};
  const first = board(),
    late = board(),
    flashed = board();
  let lateClosed = false;
  late.dev.close = () => (lateClosed = true);
  const { conn, clients } = connection({ open: () => new Promise((r) => (release = r)), client: first.dev });
  first.unplug();
  await until(() => conn.state.kind === 'waiting');
  await new Promise((r) => setTimeout(r, 30)); // the retry is now inside open()
  let paused = false;
  const pausing = conn.pause().then(() => (paused = true));
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(paused, false); // the flasher must not take the port while it is being opened
  release(late.dev);
  await pausing;
  assert(lateClosed);
  conn.resume(flashed.dev);
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(clients, [flashed.dev]);
  assertEquals(conn.client, flashed.dev);
  conn.close();
});

test('a failed open that ends after close() does not start retrying again', async () => {
  let fail: (err: Error) => void = () => {};
  let opens = 0;
  const { conn } = connection({
    open: () => {
      opens++;
      return new Promise((_, reject) => (fail = reject));
    },
    problem: () => new Promise((r) => setTimeout(() => r('slow words'), 20)),
  });
  conn.start();
  await until(() => opens === 1);
  fail(sysError('EACCES', 'no'));
  await new Promise((r) => setTimeout(r, 5)); // inside problem()
  conn.close();
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(conn.state.kind, 'closed');
  assertEquals(opens, 1);
});

test('resume after close: the flasher client is closed, not adopted', () => {
  const b = board();
  let closed = false;
  b.dev.close = () => (closed = true);
  const { conn } = connection({ open: () => Promise.reject(new Error('unused')) });
  conn.close();
  conn.resume(b.dev);
  assert(closed);
  assertEquals(conn.client, undefined);
});
