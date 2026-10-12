// stdio.ts: frames on stdout, commands from stdin. For pipes and quick looks:
//
//   deno task start --stdio | xxd
//
// The client is "connected" from the start. Logs go to stderr, never stdout.
import { DroppingWriter, type LinkEvents, pump, type Transport } from './link.ts';

export class StdioTransport implements Transport {
  readonly label = 'stdout/stdin';
  private writer: DroppingWriter | null = null;

  start(events: LinkEvents): Promise<void> {
    this.writer = new DroppingWriter(Deno.stdout.writable.getWriter());
    events.onConnect();
    void pump(Deno.stdin.readable, (bytes) => events.onData(bytes)).then(() => events.onDisconnect());
    return Promise.resolve();
  }

  write(bytes: Uint8Array): void {
    this.writer?.write(bytes);
  }

  connected(): boolean {
    return this.writer !== null;
  }

  async close(): Promise<void> {
    await this.writer?.close();
  }
}
