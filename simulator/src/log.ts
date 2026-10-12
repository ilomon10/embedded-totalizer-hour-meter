// log.ts: one human line per frame on stderr (stdout may carry frames in --stdio mode).
import { ACK_STATUS, type DecodedMessage, type Message, MSG, STATUS_FLAGS, TAGS } from './protocol.ts';

export type Verbosity = 'quiet' | 'normal' | 'verbose';

const MSG_NAME: Record<number, string> = {
  [MSG.TELEMETRY]: 'TELEMETRY',
  [MSG.EVENT]: 'EVENT',
  [MSG.COMMAND]: 'COMMAND',
  [MSG.ACK]: 'ACK',
  [MSG.IMU]: 'IMU',
};
const EVENT_NAME: Record<number, string> = { 1: 'boot', 2: 'calibration done', 3: 'modules changed' };

export function msgName(msgType: number): string {
  return MSG_NAME[msgType] ?? `msg ${msgType}`;
}

/** [name, value] for every record, values as text (tag names from the shared tag table). */
export function recordPairs(records: { tag: number; value: unknown }[]): [string, string][] {
  return records.map((r) => [TAGS[r.tag]?.name ?? `tag_${r.tag}`, String(r.value)]);
}

function time(): string {
  return new Date().toISOString().slice(11, 23);
}

function line(text: string): void {
  console.error(`${time()} ${text}`);
}

function recordsText(records: { tag: number; value: unknown }[]): string {
  return recordPairs(records).map(([name, value]) => `${name}=${value}`).join(' ');
}

function flagsText(flags: number): string {
  const names = STATUS_FLAGS.filter((_, bit) => (flags >>> bit) & 1);
  return names.length ? names.join(',') : 'none';
}

export class FrameLog {
  constructor(private readonly verbosity: Verbosity) {}

  info(text: string): void {
    if (this.verbosity !== 'quiet') line(text);
  }

  received(cmd: DecodedMessage): void {
    if (this.verbosity === 'quiet') return;
    line(`<- COMMAND #${cmd.seq} ${recordsText(cmd.records.map((r) => ({ tag: r.tag, value: r.raw })))}`);
  }

  sent(msg: Message & { seq: number }, delivered: boolean): void {
    const periodic = msg.msgType === MSG.TELEMETRY || msg.msgType === MSG.IMU;
    if (this.verbosity === 'quiet' || (periodic && this.verbosity !== 'verbose')) return;
    const name = msgName(msg.msgType);
    const note = delivered ? '' : ' (not delivered: no client / locked / output setting)';
    line(`-> ${name} #${msg.seq} ${this.summary(msg)}${note}`);
  }

  private summary(msg: Message): string {
    const value = (name: string) => msg.records.find((r) => TAGS[r.tag].name === name)?.value;
    if (this.verbosity === 'verbose') return recordsText(msg.records);
    if (msg.msgType === MSG.ACK) {
      const rejected = value('rejectedTag');
      const data = msg.records.filter((r) => ![242, 243, 59].includes(r.tag)).length;
      return `ackSeq=${value('ackSeq')} ${ACK_STATUS[Number(value('ackStatus'))]}` +
        (rejected !== undefined ? ` rejectedTag=${rejected}` : '') + (data ? ` +${data} records` : '');
    }
    if (msg.msgType === MSG.EVENT) {
      const flags = value('statusFlags');
      return `${EVENT_NAME[Number(value('eventKind'))]}` +
        (flags !== undefined
          ? ` devices=0x${Number(value('devices')).toString(16)} flags=${flagsText(Number(flags))}`
          : '');
    }
    return recordsText(msg.records);
  }
}
