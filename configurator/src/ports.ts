// ports.ts: the serial ports this PC has now, for the TUI's connect screen, and plain words for a port that
// does not open.
//
//   Linux   /dev/ttyUSB*, /dev/ttyACM* (USB serial adapters, the board's own USB), /dev/rfcomm* (Bluetooth).
//           /dev/serial/by-id names the adapter (chip and serial number): the label, and the id that finds the
//           board again when it comes back under another name after a replug.
//   macOS   /dev/cu.* except the built-in Bluetooth-Incoming-Port and debug-console.
//   Windows none: COM ports are not supported yet (tcp:// or the demo).
//
// The listing reads the file system through PortFs, so the tests run it on a fake one.
import { cacheDir } from './releases.ts';

export interface PortInfo {
  /** What to open. */
  path: string;
  /** What it is, e.g. "Silicon Labs CP2102 USB to UART Bridge Controller 0001" or "Bluetooth". */
  label: string;
  kind: 'usb' | 'bluetooth' | 'serial';
  /** The adapter's stable name (Linux /dev/serial/by-id): the same board after a replug, whatever its path. */
  id?: string;
  /** A USB-serial chip that ESP32 boards carry (CP210x, CH340/CH9102, FTDI, Espressif's own USB). */
  boardLike: boolean;
}

export interface PortFs {
  /** Names in a folder; empty when it is not there. */
  names(dir: string): Promise<string[]>;
  /** Where a symlink points, as an absolute path. */
  realPath(path: string): Promise<string>;
}

export const systemFs: PortFs = {
  async names(dir) {
    const out: string[] = [];
    try {
      for await (const e of Deno.readDir(dir)) out.push(e.name);
    } catch {
      // no such folder (no USB serial adapter was ever plugged in), or no permission
    }
    return out;
  },
  realPath: (path) => Deno.realPath(path),
};

const BOARD_CHIPS = /CP21|CP210|Silicon_Labs|CH34|CH910|QinHeng|1a86|FTDI|FT232|Espressif|USB_JTAG/i;
const MAC_SKIP = /^cu\.(Bluetooth-Incoming-Port|debug-console)$/;

/** "usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0" -> "Silicon Labs CP2102 ... 0001". */
export function byIdLabel(name: string): string {
  return name.replace(/^usb-/, '').replace(/-if\d+(-port\d+)?$/, '').replace(/_/g, ' ');
}

/** Serial ports, USB ones first, then by path (ttyUSB2 before ttyUSB10). */
export async function listPorts(fs: PortFs = systemFs, os: string = Deno.build.os): Promise<PortInfo[]> {
  if (os === 'windows') return [];
  const ports: PortInfo[] = [];
  if (os === 'darwin') {
    for (const name of await fs.names('/dev')) {
      if (!name.startsWith('cu.') || MAC_SKIP.test(name)) continue;
      const usb = /usbserial|usbmodem|SLAB_USBtoUART|wchusbserial/i.test(name);
      ports.push({
        path: `/dev/${name}`,
        label: usb ? 'USB serial' : 'serial',
        kind: usb ? 'usb' : 'serial',
        id: `/dev/${name}`, // the name already carries the USB location
        boardLike: /SLAB|wchusbserial|usbserial/i.test(name),
      });
    }
  } else {
    const byId = new Map<string, string>(); // real path -> by-id name
    for (const name of await fs.names('/dev/serial/by-id')) {
      const real = await fs.realPath(`/dev/serial/by-id/${name}`).catch(() => undefined);
      if (real) byId.set(real, name);
    }
    for (const name of await fs.names('/dev')) {
      const path = `/dev/${name}`;
      if (/^rfcomm\d+$/.test(name)) {
        ports.push({ path, label: 'Bluetooth', kind: 'bluetooth', id: path, boardLike: false });
      } else if (/^tty(USB|ACM)\d+$/.test(name)) {
        const id = byId.get(path);
        ports.push({
          path,
          label: id ? byIdLabel(id) : name.startsWith('ttyACM') ? 'USB serial (CDC)' : 'USB serial',
          kind: 'usb',
          id,
          boardLike: id ? BOARD_CHIPS.test(id) : name.startsWith('ttyUSB'),
        });
      }
    }
  }
  const rank = (p: PortInfo) => (p.kind === 'usb' ? 0 : p.kind === 'bluetooth' ? 1 : 2);
  return ports.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, 'en', { numeric: true }));
}

/** Where the board went after a replug: the port with the same adapter id, else the same path. */
export function findAgain(ports: PortInfo[], path: string, id: string | undefined): PortInfo | undefined {
  return (id && ports.find((p) => p.id === id)) || ports.find((p) => p.path === path);
}

/** The port to preselect: the last one used, else $HOUR_METER_PORT, else the first that looks like the board. */
export function preferredPort(ports: PortInfo[], last?: string, envPort?: string): number {
  for (const want of [last, envPort]) {
    const i = want ? ports.findIndex((p) => p.path === want) : -1;
    if (i >= 0) return i;
  }
  const board = ports.findIndex((p) => p.boardLike);
  return Math.max(0, board);
}

/** The ports that were not there before (just plugged in). */
export function newPorts(before: PortInfo[], now: PortInfo[]): PortInfo[] {
  const seen = new Set(before.map((p) => p.path));
  return now.filter((p) => !seen.has(p.path));
}

/** The group that owns a port, for the "add yourself to the group" hint (Linux: dialout, uucp on Arch). */
async function portGroup(path: string): Promise<string | undefined> {
  try {
    const gid = (await Deno.stat(path)).gid;
    const line = (await Deno.readTextFile('/etc/group')).split('\n').find((l) => l.split(':')[2] === String(gid));
    return line?.split(':')[0];
  } catch {
    return undefined;
  }
}

/** A port that did not open, in plain words with what to do about it. */
export async function openProblem(err: unknown, spec: string, os: string = Deno.build.os): Promise<string> {
  const e = err as Error;
  if (spec.startsWith('tcp://')) {
    if (e instanceof Deno.errors.ConnectionRefused) {
      return `nothing answers on ${spec}: is the simulator or bridge running?`;
    }
    return `${spec}: ${e.message}`;
  }
  if (e instanceof Deno.errors.NotFound) return `${spec} is not there: plug in the board, or pick another port`;
  if (e instanceof Deno.errors.PermissionDenied) {
    if (os !== 'linux') return `no permission to open ${spec}`;
    const group = await portGroup(spec) ?? 'dialout';
    return `no permission to open ${spec}: add yourself to the ${group} group ` +
      `(sudo usermod -aG ${group} $USER), then log out and back in`;
  }
  if (e instanceof Deno.errors.Busy || /busy/i.test(e.message)) {
    return `${spec} is in use by another program (another hour-meter, a serial monitor, ModemManager)`;
  }
  return `${spec}: ${e.message}`;
}

// ------------------------------------------------------------ last port --

const prefsFile = (env: (name: string) => string | undefined) => `${cacheDir(env)}/tui.json`;

/** The port the TUI last connected to (preselected on the connect screen). */
export async function loadLastPort(env: (name: string) => string | undefined): Promise<string | undefined> {
  try {
    const prefs = JSON.parse(await Deno.readTextFile(prefsFile(env)));
    return typeof prefs.lastPort === 'string' ? prefs.lastPort : undefined;
  } catch {
    return undefined;
  }
}

export async function saveLastPort(env: (name: string) => string | undefined, port: string): Promise<void> {
  try {
    await Deno.mkdir(cacheDir(env), { recursive: true });
    await Deno.writeTextFile(prefsFile(env), JSON.stringify({ lastPort: port }) + '\n');
  } catch {
    // only a convenience: the next start preselects another port
  }
}
