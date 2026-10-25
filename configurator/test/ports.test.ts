// ports.test.ts: the connect screen's port listing on a fake file system, and the words for a port that fails.
import { test } from 'bun:test';

import { assertEquals, assertMatch, sysError } from './assert.ts';
import { byIdLabel, findAgain, listPorts, newPorts, openProblem, type PortFs, preferredPort } from '../src/ports.ts';

function fakeFs(dirs: Record<string, string[]>, links: Record<string, string> = {}): PortFs {
  return {
    names: (dir) => Promise.resolve(dirs[dir] ?? []),
    realPath: (path) => (links[path] ? Promise.resolve(links[path]) : Promise.reject(sysError('ENOENT'))),
  };
}

const CP2102 = 'usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0';

test('linux: USB serial ports first, named by their adapter, Bluetooth after, ttyS left out', async () => {
  const fs = fakeFs(
    {
      '/dev': ['ttyS0', 'ttyS1', 'rfcomm0', 'ttyUSB10', 'ttyACM0', 'ttyUSB2', 'tty0', 'null'],
      '/dev/serial/by-id': [CP2102],
    },
    { [`/dev/serial/by-id/${CP2102}`]: '/dev/ttyUSB2' },
  );
  const ports = await listPorts(fs, 'linux');
  assertEquals(
    ports.map((p) => p.path),
    ['/dev/ttyACM0', '/dev/ttyUSB2', '/dev/ttyUSB10', '/dev/rfcomm0'],
  );
  assertEquals(ports[1], {
    path: '/dev/ttyUSB2',
    label: 'Silicon Labs CP2102 USB to UART Bridge Controller 0001',
    kind: 'usb',
    id: CP2102,
    boardLike: true,
  });
  assertEquals(ports[3].kind, 'bluetooth');
});

test('macOS: cu.* ports without the built-in ones; Windows: none', async () => {
  const fs = fakeFs({
    '/dev': ['cu.Bluetooth-Incoming-Port', 'cu.debug-console', 'cu.usbserial-1410', 'tty.usbserial-1410'],
  });
  assertEquals(
    (await listPorts(fs, 'darwin')).map((p) => [p.path, p.boardLike]),
    [['/dev/cu.usbserial-1410', true]],
  );
  assertEquals(await listPorts(fs, 'windows'), []);
});

test('by-id names read as words', () => {
  assertEquals(byIdLabel('usb-1a86_USB_Serial-if00-port0'), '1a86 USB Serial');
  assertEquals(
    byIdLabel('usb-Espressif_USB_JTAG_serial_debug_unit_AA:BB-if00'),
    'Espressif USB JTAG serial debug unit AA:BB',
  );
});

test('preselect: the last port used, else $HOUR_METER_PORT, else the first that looks like a board', () => {
  const ports = [
    { path: '/dev/ttyACM0', label: '', kind: 'usb' as const, boardLike: false },
    { path: '/dev/ttyUSB0', label: '', kind: 'usb' as const, boardLike: true },
    { path: '/dev/rfcomm0', label: '', kind: 'bluetooth' as const, boardLike: false },
  ];
  assertEquals(preferredPort(ports, '/dev/rfcomm0', '/dev/ttyACM0'), 2);
  assertEquals(preferredPort(ports, '/dev/gone', '/dev/ttyACM0'), 0);
  assertEquals(preferredPort(ports), 1);
  assertEquals(preferredPort([]), 0);
});

test('a replugged board is found by its adapter id, else by its path; new ports are told apart', () => {
  const a = { path: '/dev/ttyUSB1', label: '', kind: 'usb' as const, id: 'usb-X', boardLike: true };
  const b = { path: '/dev/ttyUSB0', label: '', kind: 'usb' as const, id: 'usb-Y', boardLike: true };
  assertEquals(findAgain([b, a], '/dev/ttyUSB0', 'usb-X'), a);
  assertEquals(findAgain([b], '/dev/ttyUSB0', 'usb-X'), b);
  assertEquals(findAgain([], '/dev/ttyUSB0', 'usb-X'), undefined);
  assertEquals(newPorts([b], [b, a]), [a]);
});

test('a port that does not open says why and what to do', async () => {
  assertMatch(await openProblem(sysError('ENOENT', 'x'), '/dev/ttyUSB0'), /is not there: plug in the board/);
  assertMatch(
    await openProblem(sysError('EACCES', 'x'), '/dev/nonexistent-port', 'linux'),
    /no permission .* dialout group \(sudo usermod -aG dialout \$USER\)/,
  );
  assertMatch(await openProblem(sysError('EBUSY', 'x'), '/dev/ttyUSB0'), /in use by another program/);
  assertMatch(await openProblem(sysError('ECONNREFUSED', 'x'), 'tcp://127.0.0.1:5555'), /nothing answers/);
});
