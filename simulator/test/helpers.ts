// helpers.ts: shared test utilities.
import { FakeClock } from '../src/clock.ts';
import { type DeviceOptions, SimDevice } from '../src/device.ts';
import { codec, type DecodedMessage, Device, frameBytes, type Message, MSG, TAGS } from '../src/protocol.ts';

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Encode like the firmware's FrameWriter: header + records + CRC, COBS, 0x00. */
export function frameHex(msg: Message, seq: number, deviceId: number): string {
  return hex(frameBytes(codec.encode({ ...msg, seq, deviceId })));
}

/** A COMMAND as the device receives it. `extra` adds raw records (e.g. unknown tags). */
export function command(
  seq: number,
  values: Record<string, number | boolean>,
  extra: { tag: number; fmt: string; value: number }[] = [],
): DecodedMessage {
  const packet = codec.encode({
    msgType: MSG.COMMAND,
    seq,
    deviceId: 0,
    timestamp: 0,
    values,
    records: extra,
  } as never);
  return codec.decode(packet);
}

export interface Sent {
  msg: DecodedMessage;
  periodic: boolean;
}

/** A device on a FakeClock that records every frame it sends (decoded, so tests read names). */
export function makeDevice(options: Partial<DeviceOptions> = {}) {
  const clock = new FakeClock();
  const sent: Sent[] = [];
  const device = new SimDevice(
    {
      deviceId: 0x1a2b3c4d,
      runSeconds: 4_500_000,
      totalCount: 15_000,
      pulsesPerSecond: 3.5,
      fitted: Device.eeprom | Device.rtc | Device.imu | Device.mag,
      rtcBattery: true,
      bluetoothSession: false,
      btPin: 1234,
      random: () => 0.5,
      ...options,
    },
    clock,
    (frame, _msg, periodic) => sent.push({ msg: codec.decodeFrame(frame), periodic }),
  );
  /** Advance time in poll-sized steps, like main.ts. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 10) {
      clock.advance(10);
      device.poll();
    }
  };
  const last = () => sent[sent.length - 1].msg;
  const lastOf = (msgType: number) => [...sent].reverse().find((s) => s.msg.msgType === msgType)?.msg;
  return { clock, device, sent, run, last, lastOf };
}

export function tagsOf(msg: DecodedMessage): number[] {
  return msg.records.map((r) => r.tag);
}

export function tagNumber(name: string): number {
  return Number(Object.entries(TAGS).find(([, def]) => def.name === name)?.[0]);
}
