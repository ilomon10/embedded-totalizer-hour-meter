// links.ts: byte links to the device. DeviceClient only needs { readable, write, close }.
//
//   /dev/ttyUSB0, /dev/rfcomm0, /dev/cu.usbserial-1410   serial port (Linux, macOS)
//   tcp://127.0.0.1:5555                                  TCP (simulator --tcp, serial-to-TCP bridges)
//
// Serial ports are plain files: opened with node:fs, read through Bun's file
// stream, configured with `stty` (115200 8N1, raw). No native add-on (npm
// serialport), so the binary cross-compiles as is. Windows COM ports are not
// supported yet: use a serial-to-TCP bridge and tcp://.
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { Readable } from 'node:stream';

import { OS } from './platform.ts';

export interface Link {
  readonly readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export async function openLink(spec: string, baudRate = 115200): Promise<Link> {
  if (spec.startsWith('tcp://')) return await openTcp(spec);
  return await openSerial(spec, baudRate);
}

async function openTcp(spec: string): Promise<Link> {
  const url = new URL(spec);
  const socket = createConnection({ host: url.hostname || '127.0.0.1', port: Number(url.port), noDelay: true });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.removeAllListeners('error');
  socket.on('error', () => {}); // a reset ends `readable` with the error; without a listener it would crash the tool
  return {
    readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    write: (bytes) => new Promise((resolve, reject) => socket.write(bytes, (err) => (err ? reject(err) : resolve()))),
    close: () => void socket.destroy(),
  };
}

async function openSerial(path: string, baudRate: number): Promise<Link> {
  if (OS === 'windows') {
    throw new Error(
      `serial ports are not supported on Windows yet: use tcp://host:port (serial-to-TCP bridge) or --demo`,
    );
  }
  // One handle to read, one to write. The read handle is non-blocking, so Bun polls it and a read waiting for
  // data never holds back a write (a command must leave even when the device sends nothing; the ROM bootloader
  // never does). Open first, then configure: macOS resets the line settings when the last handle closes.
  const input = await open(path, constants.O_RDONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
  let output: FileHandle | undefined;
  try {
    output = await open(path, constants.O_WRONLY | constants.O_NOCTTY);
    await setBaud(path, baudRate);
  } catch (err) {
    await output?.close().catch(() => {});
    await input.close().catch(() => {});
    throw err;
  }
  const out = output;
  // The caller's reader locks `readable`, so close() cancels this inner reader instead. Cancelling ends the read
  // (Bun keeps the fd open), and only then is the fd closed: a closed fd number may be reused at once.
  const source = Bun.file(input.fd).stream().getReader();
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await source.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel: (reason) => source.cancel(reason),
  });
  let closed: Promise<void> | undefined;
  return {
    readable,
    write: async (bytes) => {
      let done = 0;
      while (done < bytes.length) done += (await out.write(bytes, done)).bytesWritten;
    },
    close: () => {
      closed ??= (async () => {
        await source.cancel().catch(() => {});
        await Promise.all([out.close(), input.close()]).catch(() => {});
      })();
    },
  };
}

/** Set an open serial port to `baudRate`, 8N1, raw (stty). Also used to change speed while open (flash.ts). */
export async function setBaud(path: string, baudRate: number): Promise<void> {
  const device = OS === 'darwin' ? '-f' : '-F';
  const args = [device, path, String(baudRate), 'raw', '-echo', 'cs8', '-cstopb', '-parenb', '-crtscts', 'clocal'];
  let stty: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
  try {
    stty = Bun.spawn(['stty', ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  } catch {
    throw new Error('stty not found: it is needed to configure the serial port');
  }
  const [code, stderr] = await Promise.all([stty.exited, new Response(stty.stderr).text()]);
  if (code !== 0) throw new Error(`stty ${path}: ${stderr.trim()}`);
}

/** Two connected in-memory links (tests, --demo). Bytes written on one side are read on the other. */
export function linkPair(): [Link, Link] {
  const a = new TransformStream<Uint8Array, Uint8Array>();
  const b = new TransformStream<Uint8Array, Uint8Array>();
  const side = (readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>): Link => {
    const writer = writable.getWriter();
    return {
      readable,
      write: (bytes) => writer.write(bytes),
      close: () => void writer.close().catch(() => {}),
    };
  };
  return [side(a.readable, b.writable), side(b.readable, a.writable)];
}
