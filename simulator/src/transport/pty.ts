// pty.ts: a virtual serial port made by socat.
//
//   socat -d -d PTY,link=/tmp/ttyHourMeter,rawer,wait-slave STDIO
//
// socat creates a pseudo-terminal and a stable symlink to it. `wait-slave`
// makes it wait until a driver opens the port; when the driver closes it,
// socat logs "PTY closed". We end the session right there (socat itself may
// linger, blocked on a full pty buffer) and start a fresh socat, so every open
// is one session, like plugging in the USB cable. Drivers open the link at any
// baud rate with any serial library (it is a real tty).
import { DroppingWriter, type LinkEvents, pump, type Transport } from './link.ts';

const CONNECTED_LOG = 'starting data transfer loop';
const DISCONNECTED_LOGS = ['PTY closed', 'is at EOF'];

export class PtyTransport implements Transport {
  private child: Deno.ChildProcess | null = null;
  private writer: DroppingWriter | null = null;
  private isConnected = false;
  private closing = false;

  constructor(readonly label: string) {}

  async start(events: LinkEvents): Promise<void> {
    await assertSocatInstalled();
    void this.loop(events);
  }

  private async loop(events: LinkEvents): Promise<void> {
    // The next socat starts only after the old one exited (and removed its symlink), so the
    // link is missing for a few ms between sessions: drivers should retry a failed open.
    while (!this.closing) await this.runSession(events);
  }

  private async runSession(events: LinkEvents): Promise<void> {
    const child = new Deno.Command('socat', {
      args: ['-d', '-d', `PTY,link=${this.label},rawer,wait-slave`, 'STDIO'],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    this.child = child;
    this.writer = new DroppingWriter(child.stdin.getWriter());
    const watchLog = this.watchLog(child, events);
    const readData = pump(child.stdout, (bytes) => events.onData(bytes));
    await child.status;
    await Promise.all([watchLog, readData]);
    await this.writer.close();
    this.writer = null;
    this.child = null;
    if (this.isConnected) {
      this.isConnected = false;
      events.onDisconnect();
    }
  }

  // socat's log tells us when a client opens and closes the tty.
  private async watchLog(child: Deno.ChildProcess, events: LinkEvents): Promise<void> {
    const decoder = new TextDecoder();
    await pump(child.stderr, (bytes) => {
      const text = decoder.decode(bytes);
      if (!this.isConnected && text.includes(CONNECTED_LOG)) {
        this.isConnected = true;
        events.onConnect();
      } else if (this.isConnected && DISCONNECTED_LOGS.some((log) => text.includes(log))) {
        this.isConnected = false;
        events.onDisconnect();
        kill(child); // do not wait for socat to drain into a pty nobody reads
      }
    });
  }

  write(bytes: Uint8Array): void {
    if (this.isConnected) this.writer?.write(bytes);
  }

  connected(): boolean {
    return this.isConnected;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.child) {
      kill(this.child); // socat removes the symlink on exit
      await this.child.status;
    }
  }
}

function kill(child: Deno.ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    // already exited
  }
}

async function assertSocatInstalled(): Promise<void> {
  try {
    await new Deno.Command('socat', { args: ['-V'], stdout: 'null', stderr: 'null' }).output();
  } catch {
    throw new Error('socat not found. Install it (apt/pacman/brew install socat), or use --tcp <port> instead.');
  }
}
