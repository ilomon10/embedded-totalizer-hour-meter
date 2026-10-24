// links.ts: byte links to the device. DeviceClient only needs { readable, write, close }.
//
//   /dev/ttyUSB0, /dev/rfcomm0, /dev/cu.usbserial-1410   serial port (Linux, macOS)
//   tcp://127.0.0.1:5555                                  TCP (simulator --tcp, serial-to-TCP bridges)
//
// Serial ports are opened with Deno.open and configured with `stty` (115200 8N1,
// raw). The npm serialport package cannot be used: under Deno its native add-on
// opens the port, but every read/write then fails with EBADF. Windows COM ports
// are not supported yet: use a serial-to-TCP bridge and tcp://.

export interface Link {
  readonly readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export async function openLink(spec: string, baudRate = 115200): Promise<Link> {
  if (spec.startsWith('tcp://')) return openTcp(spec);
  return await openSerial(spec, baudRate);
}

async function openTcp(spec: string): Promise<Link> {
  const url = new URL(spec);
  const conn = await Deno.connect({ hostname: url.hostname || '127.0.0.1', port: Number(url.port) });
  conn.setNoDelay(true);
  const writer = conn.writable.getWriter();
  return {
    readable: conn.readable,
    write: (bytes) => writer.write(bytes),
    close: () => closeQuietly(conn),
  };
}

async function openSerial(path: string, baudRate: number): Promise<Link> {
  if (Deno.build.os === 'windows') {
    throw new Error(
      `serial ports are not supported on Windows yet: use tcp://host:port (serial-to-TCP bridge) or --demo`,
    );
  }
  // One handle to read, one to write: Deno runs the operations on one handle one after the other, so a read
  // waiting for data would hold back every write (a command would only leave after the device sent something;
  // the ROM bootloader never does). Open first, then configure: macOS resets the line settings when the last
  // handle closes.
  const input = await Deno.open(path, { read: true });
  let output: Deno.FsFile | undefined;
  try {
    output = await Deno.open(path, { write: true });
    await setBaud(path, baudRate);
  } catch (err) {
    if (output) closeQuietly(output);
    closeQuietly(input);
    throw err;
  }
  const out = output;
  return {
    readable: input.readable,
    write: async (bytes) => {
      let done = 0;
      while (done < bytes.length) done += await out.write(bytes.subarray(done));
    },
    close: () => {
      closeQuietly(out);
      closeQuietly(input);
    },
  };
}

/** Set an open serial port to `baudRate`, 8N1, raw (stty). Also used to change speed while open (flash.ts). */
export async function setBaud(path: string, baudRate: number): Promise<void> {
  const device = Deno.build.os === 'darwin' ? '-f' : '-F';
  const args = [device, path, String(baudRate), 'raw', '-echo', 'cs8', '-cstopb', '-parenb', '-crtscts', 'clocal'];
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command('stty', { args, stdout: 'null', stderr: 'piped' }).output();
  } catch {
    throw new Error('stty not found: it is needed to configure the serial port');
  }
  if (output.code !== 0) throw new Error(`stty ${path}: ${new TextDecoder().decode(output.stderr).trim()}`);
}

function closeQuietly(resource: { close(): void }): void {
  try {
    resource.close();
  } catch {
    // already closed
  }
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
