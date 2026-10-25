// tcp.ts: the same byte stream on a TCP port (no socat needed; works on Windows
// and in Docker). One client at a time, like a serial port: a second client
// is refused while the first is connected. Every connection is a new session.
import { createServer, type Server, type Socket } from 'node:net';

import { type ByteWriter, DroppingWriter, type LinkEvents, type Transport } from './link.ts';

export class TcpTransport implements Transport {
  readonly label: string;
  private server: Server | null = null;
  private socket: Socket | null = null;
  private writer: DroppingWriter | null = null;

  constructor(private readonly port: number, private readonly hostname = '127.0.0.1') {
    this.label = `tcp://${hostname}:${port}`;
  }

  start(events: LinkEvents): Promise<void> {
    const server = createServer((socket) => {
      if (this.socket) socket.destroy(); // busy: one client at a time
      else this.serve(socket, events);
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject); // e.g. the port is taken
      server.listen(this.port, this.hostname, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  private serve(socket: Socket, events: LinkEvents): void {
    socket.setNoDelay(true);
    this.socket = socket;
    this.writer = new DroppingWriter(socketWriter(socket));
    events.onConnect();
    socket.on('data', (chunk: Buffer) => events.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)));
    socket.on('error', () => {}); // a reset ends the session like a close
    socket.on('close', () => {
      this.socket = null;
      this.writer = null;
      events.onDisconnect();
    });
  }

  write(bytes: Uint8Array): void {
    this.writer?.write(bytes);
  }

  connected(): boolean {
    return this.socket !== null;
  }

  async close(): Promise<void> {
    this.server?.close();
    await this.writer?.close();
  }
}

function socketWriter(socket: Socket): ByteWriter {
  return {
    write: (bytes) => new Promise<void>((resolve, reject) => socket.write(bytes, (err) => (err ? reject(err) : resolve()))),
    close: () => new Promise<void>((resolve) => socket.end(resolve)),
  };
}
