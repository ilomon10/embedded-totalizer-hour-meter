// esp-rom.test.ts: SLIP framing, command/answer packets, and the ROM loader client against test/fake-rom.ts.
import { test } from 'bun:test';

import { assertEquals, assertRejects } from './assert.ts';
import {
  blockChecksum,
  commandPacket,
  EspRom,
  OP,
  parseAnswer,
  SlipDecoder,
  slipEncode,
  u32le,
} from '../src/esp-rom.ts';
import { fakeRom } from './fake-rom.ts';

test('SLIP escapes END and ESC, and finds packets after boot text and in split reads', () => {
  const packet = Uint8Array.of(0x01, 0xc0, 0x02, 0xdb, 0x03);
  const framed = slipEncode(packet);
  assertEquals(Array.from(framed), [0xc0, 0x01, 0xdb, 0xdc, 0x02, 0xdb, 0xdd, 0x03, 0xc0]);
  const got: number[][] = [];
  const slip = new SlipDecoder((p) => got.push(Array.from(p)));
  const boot = new TextEncoder().encode('ets Jun  8 2016 00:22:57\r\nwaiting for download\r\n');
  for (const b of [...boot, ...framed, ...framed]) slip.push(Uint8Array.of(b)); // one byte per read
  assertEquals(got, [Array.from(packet), Array.from(packet)]);
});

test('a bad SLIP escape drops only that packet', () => {
  const got: number[][] = [];
  const slip = new SlipDecoder((p) => got.push(Array.from(p)));
  slip.push(Uint8Array.of(0xc0, 0x01, 0xdb, 0x00, 0x02, 0xc0)); // 0xDB 0x00 is not an escape
  slip.push(slipEncode(Uint8Array.of(0x05)));
  assertEquals(got, [[0x05]]);
});

test('command packets carry op, size and checksum; answers parse', () => {
  assertEquals(
    Array.from(commandPacket(OP.READ_REG, u32le(0x40001000))),
    [0x00, 0x0a, 4, 0, 0, 0, 0, 0, 0x00, 0x10, 0x00, 0x40],
  );
  assertEquals(blockChecksum(new Uint8Array(0)), 0xef);
  assertEquals(blockChecksum(Uint8Array.of(0xef, 0x01)), 0x01);
  const answer = parseAnswer(Uint8Array.of(0x01, 0x0a, 4, 0, 0x83, 0x1d, 0xf0, 0x00, 0, 0, 0, 0));
  assertEquals([answer?.op, answer?.value, answer?.data.length], [0x0a, 0x00f01d83, 4]);
  assertEquals(parseAnswer(commandPacket(OP.SYNC, new Uint8Array(0))), undefined); // a command, not an answer
});

test('sync, chip detection and MAC address against the fake ROM', async () => {
  const rom = fakeRom();
  const client = new EspRom(rom.host);
  await client.sync();
  assertEquals((await client.detectChip()).mac, 'aa:bb:11:22:33:44');
  rom.host.close();
});

test('a failed command gives the ROM error text; another chip is refused', async () => {
  const failing = fakeRom({ failOp: OP.SPI_ATTACH, error: 0x06 });
  const client = new EspRom(failing.host);
  await client.sync();
  await assertRejects(() => client.spiAttach(), /spi attach failed: failed to act on the message/);
  failing.host.close();

  const s3 = fakeRom({ chipMagic: 0x9 });
  const other = new EspRom(s3.host);
  await other.sync();
  await assertRejects(() => other.detectChip(), /not an ESP32 \(chip magic 0x9\)/);
  s3.host.close();
});

test('no bootloader on the line: sync gives up', async () => {
  const rom = fakeRom({ silent: true });
  await assertRejects(() => new EspRom(rom.host).sync(2), /no answer from the ESP32 bootloader/);
  rom.host.close();
});

test('a port that takes no data fails the command instead of hanging', async () => {
  const stuck = { readable: new ReadableStream<Uint8Array>(), write: () => new Promise<void>(() => {}), close() {} };
  const client = new EspRom(stuck);
  await assertRejects(() => client.command(OP.READ_REG, u32le(0), { timeoutMs: 50 }), /the port takes no data/);
  await assertRejects(() => client.sync(2), /sync: the port takes no data/); // the real cause, not "no answer"
});
