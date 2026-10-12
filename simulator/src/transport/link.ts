// link.ts: what every transport (pty, tcp, stdio) offers the simulator.
//
// Like a real UART, a transport never blocks the device: bytes written while
// no client is connected, or while the client is not reading, are dropped
// (the device keeps running, exactly as the firmware does).

export interface LinkEvents {
  /** A client opened the port / connected. */
  onConnect(): void;
  onDisconnect(): void;
  /** Bytes from the client (COMMAND frames). */
  onData(bytes: Uint8Array): void;
}

export interface Transport {
  /** Where to connect, for the startup banner, e.g. "/tmp/ttyHourMeter". */
  readonly label: string;
  start(events: LinkEvents): Promise<void>;
  write(bytes: Uint8Array): void;
  connected(): boolean;
  close(): Promise<void>;
}

const MAX_BACKLOG_BYTES = 16 * 1024;

/**
 * Serialises async writes to one stream. Drops new bytes once the backlog is
 * full, so a client that stops reading cannot stall the device.
 */
export class DroppingWriter {
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private busy = false;
  dropped = 0;

  constructor(private readonly writer: WritableStreamDefaultWriter<Uint8Array>) {}

  write(bytes: Uint8Array): void {
    if (this.queuedBytes + bytes.length > MAX_BACKLOG_BYTES) {
      this.dropped += bytes.length;
      return;
    }
    this.queue.push(bytes);
    this.queuedBytes += bytes.length;
    if (!this.busy) void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue.shift() as Uint8Array;
        this.queuedBytes -= chunk.length;
        await this.writer.write(chunk);
      }
    } catch {
      this.queue = []; // the other side went away; the transport reports the disconnect
      this.queuedBytes = 0;
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // already closed by the other side
    }
  }
}

/** Pump a readable stream into onData until it ends. */
export async function pump(readable: ReadableStream<Uint8Array>, onData: (bytes: Uint8Array) => void): Promise<void> {
  try {
    for await (const chunk of readable) onData(chunk);
  } catch {
    // stream closed underneath us: treated as end of data
  }
}
