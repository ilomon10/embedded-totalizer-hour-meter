// tcp.ts: the same byte stream on a TCP port (no socat needed; works on Windows
// and in Docker). One client at a time, like a serial port: a second client
// is refused while the first is connected. Every connection is a new session.
import { DroppingWriter, type LinkEvents, pump, type Transport } from './link.ts';

export class TcpTransport implements Transport {
  readonly label: string;
  private listener: Deno.TcpListener | null = null;
  private conn: Deno.TcpConn | null = null;
  private writer: DroppingWriter | null = null;

  constructor(private readonly port: number, private readonly hostname = '127.0.0.1') {
    this.label = `tcp://${hostname}:${port}`;
  }

  start(events: LinkEvents): Promise<void> {
    this.listener = Deno.listen({ port: this.port, hostname: this.hostname });
    void this.accept(this.listener, events);
    return Promise.resolve();
  }

  private async accept(listener: Deno.TcpListener, events: LinkEvents): Promise<void> {
    try {
      for await (const conn of listener) {
        if (this.conn) {
          conn.close(); // busy: one client at a time
          continue;
        }
        void this.serve(conn, events);
      }
    } catch {
      // listener closed
    }
  }

  private async serve(conn: Deno.TcpConn, events: LinkEvents): Promise<void> {
    conn.setNoDelay(true);
    this.conn = conn;
    this.writer = new DroppingWriter(conn.writable.getWriter());
    events.onConnect();
    await pump(conn.readable, (bytes) => events.onData(bytes));
    this.conn = null;
    this.writer = null;
    events.onDisconnect();
  }

  write(bytes: Uint8Array): void {
    this.writer?.write(bytes);
  }

  connected(): boolean {
    return this.conn !== null;
  }

  async close(): Promise<void> {
    this.listener?.close();
    await this.writer?.close();
  }
}
