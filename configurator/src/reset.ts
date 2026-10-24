// reset.ts: ways to restart a device that no longer answers commands.
//
//   panic signal  PANIC_ZERO_RUN zero bytes: the firmware restarts at once (no frame, no ACK).
//                 Wired ports only (USB, UART pins, tcp:// bridges of those), never Bluetooth.
//   hard reset    pulse EN through the USB-serial adapter's modem lines, like esptool's hard_reset:
//                 DTR off (IO0 high, so normal boot), RTS on (EN low) 100 ms, RTS off.
//   bootloader    the same lines, but IO0 is held low while EN comes up: the ESP32 starts its ROM
//                 bootloader (download mode) instead of the firmware. Used by flash.ts.
//
// The pure parts (constants per OS, the step lists, runSteps) are unit-tested; only runModemSteps() touches libc
// through Deno.dlopen (needs --allow-ffi, which -A includes), so test/ never calls it.
import type { Link } from './links.ts';
import { PANIC_ZERO_RUN } from './tags.ts';

export type Line = 'dtr' | 'rts';
export type Step = { set: Line; on: boolean } | { wait: number };

/** DTR off, RTS on (EN low) for 100 ms, RTS off. IO0 (DTR) stays high, so the chip runs, not download mode. */
export function hardResetSteps(): Step[] {
  return [{ set: 'dtr', on: false }, { set: 'rts', on: true }, { wait: 100 }, { set: 'rts', on: false }];
}

/**
 * Into the ROM bootloader (esptool's classic reset): EN low for 100 ms with IO0 high, then IO0 low (DTR on) while
 * EN comes up, held `holdMs` (esptool tries 50 ms, then 550 ms for boards with a slow EN capacitor), then IO0 free.
 */
export function bootloaderSteps(holdMs = 50): Step[] {
  return [
    { set: 'dtr', on: false },
    { set: 'rts', on: true },
    { wait: 100 },
    { set: 'dtr', on: true },
    { set: 'rts', on: false },
    { wait: holdMs },
    { set: 'dtr', on: false },
  ];
}

/** Bytes of the panic signal: exactly PANIC_ZERO_RUN zeros. */
export function panicPayload(): Uint8Array {
  return new Uint8Array(PANIC_ZERO_RUN);
}

export async function sendPanic(link: Pick<Link, 'write'>): Promise<void> {
  await link.write(panicPayload());
}

/** The panic signal and the hard reset need a wired port: not Bluetooth (/dev/rfcomm*), not tcp://, not --demo. */
export function isLocalSerial(spec: string, demo = false): boolean {
  return !demo && !spec.startsWith('tcp://') && !/rfcomm/i.test(spec);
}

export interface SerialConstants {
  libc: string[]; // candidate library names, first that loads wins
  TIOCMBIS: number;
  TIOCMBIC: number;
  TIOCM_DTR: number;
  TIOCM_RTS: number;
  O_RDWR: number;
  O_NOCTTY: number;
  O_NONBLOCK: number;
}

export const NO_HARD_RESET = 'hard reset needs Linux or macOS; use --signal';

/** libc names and ioctl/open constants per OS. Throws on Windows. */
export function serialConstants(os: string): SerialConstants {
  const common = { TIOCM_DTR: 0x002, TIOCM_RTS: 0x004, O_RDWR: 2 };
  if (os === 'linux') {
    return {
      ...common,
      libc: ['libc.so.6'],
      TIOCMBIS: 0x5416,
      TIOCMBIC: 0x5417,
      O_NOCTTY: 0x100,
      O_NONBLOCK: 0x800,
    };
  }
  if (os === 'darwin') {
    return {
      ...common,
      libc: ['libSystem.B.dylib', '/usr/lib/libSystem.dylib'],
      TIOCMBIS: 0x8004746c,
      TIOCMBIC: 0x8004746b,
      O_NOCTTY: 0x20000,
      O_NONBLOCK: 0x4,
    };
  }
  throw new Error(NO_HARD_RESET);
}

/** Execute steps against `io` (the FFI in production, a recorder in tests). */
export async function runSteps(
  steps: Step[],
  io: { set(line: Line, on: boolean): void; sleep(ms: number): Promise<void> },
): Promise<void> {
  for (const step of steps) {
    if ('wait' in step) await io.sleep(step.wait);
    else io.set(step.set, step.on);
  }
}

const ERRNO: Record<number, string> = {
  2: 'no such port',
  13: 'permission denied (add your user to the dialout group)',
  16: 'port busy',
  19: 'no such device',
  22: 'invalid argument',
  25: 'not a USB-serial port with modem lines',
};

/**
 * Hard-reset the board on serial port `path`. Opens the port a second time just for the modem lines, so the
 * caller's own handle stays open and readable (it receives the boot EVENT). The kernel only drops DTR/RTS when
 * the last handle closes, which is not the case here.
 */
export async function hardReset(path: string): Promise<void> {
  await runModemSteps(path, hardResetSteps());
}

/** Drive DTR/RTS of serial port `path` through `steps` (see hardReset). `job` names the caller in errors. */
export async function runModemSteps(path: string, steps: Step[], job = 'hard reset'): Promise<void> {
  const k = serialConstants(Deno.build.os);
  const libc = loadLibc(k.libc, job);
  try {
    const fail = (what: string): never => {
      const e = libc.errno();
      throw new Error(`${job}: ${what} ${path} failed: ${ERRNO[e] ?? `errno ${e}`}`);
    };
    const fd = libc.open(new TextEncoder().encode(`${path}\0`), k.O_RDWR | k.O_NOCTTY | k.O_NONBLOCK);
    if (fd < 0) fail('open');
    try {
      await runSteps(steps, {
        set: (line, on) => {
          const bits = new Int32Array([line === 'dtr' ? k.TIOCM_DTR : k.TIOCM_RTS]);
          if (libc.ioctl(fd, on ? k.TIOCMBIS : k.TIOCMBIC, bits) < 0) fail('setting the modem lines of');
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
    } finally {
      libc.close(fd);
    }
  } finally {
    libc.unload();
  }
}

interface Libc {
  open(path: Uint8Array, flags: number): number;
  ioctl(fd: number, request: number, bits: Int32Array): number;
  close(fd: number): number;
  errno(): number;
  unload(): void;
}

// ioctl() is variadic. Apple arm64 passes variadic arguments on the stack, so there the pointer is declared as the
// 9th parameter (the first 8 integers fill registers, the 9th lands on the stack where ioctl looks for it).
function loadLibc(names: string[], job: string): Libc {
  const mac = Deno.build.os === 'darwin';
  const stackArgs = mac && Deno.build.arch === 'aarch64';
  const ioctlParams = stackArgs
    ? ['i32', 'u64', 'u64', 'u64', 'u64', 'u64', 'u64', 'u64', 'buffer']
    : ['i32', 'u64', 'buffer'];
  const symbols = {
    open: { parameters: ['buffer', 'i32'], result: 'i32' },
    ioctl: { parameters: ioctlParams, result: 'i32' },
    close: { parameters: ['i32'], result: 'i32' },
    errno: { name: mac ? '__error' : '__errno_location', parameters: [], result: 'pointer' },
  } as const;
  let last: unknown;
  for (const name of names) {
    try {
      // The symbol table is built at run time (arm64 variant), so its type is erased here.
      // deno-lint-ignore no-explicit-any
      const lib = Deno.dlopen(name, symbols as any) as any;
      const s = lib.symbols;
      return {
        open: (path, flags) => s.open(path, flags),
        ioctl: (fd, request, bits) =>
          stackArgs ? s.ioctl(fd, request, 0, 0, 0, 0, 0, 0, bits) : s.ioctl(fd, request, bits),
        close: (fd) => s.close(fd),
        errno: () => {
          const p = s.errno();
          return p ? new Deno.UnsafePointerView(p).getInt32() : 0;
        },
        unload: () => lib.close(),
      };
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`${job}: cannot load libc (${names.join(', ')}): ${(last as Error)?.message}`);
}
