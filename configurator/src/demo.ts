// demo.ts: --demo runs the simulator's device in-process (no hardware, no socat).
// It is the same SimDevice as `simulator/`, so the frames are byte-identical to
// the firmware's.
import { createRng, realClock } from '../../simulator/src/clock.ts';
import { SimDevice } from '../../simulator/src/device.ts';
import { Device } from '../../simulator/src/protocol.ts';
import { parseScenario } from '../../simulator/src/scenarios.ts';
import { FrameSplitter } from '../../simulator/src/splitter.ts';
import { type Link, linkPair } from './links.ts';

const POLL_MS = 10;

/** A link to a simulated hour meter. Closing the link stops the simulation. */
export function createDemoLink(): Link {
  const [host, deviceSide] = linkPair();
  const random = createRng(1);
  const engine = parseScenario('engine-cycle', random);
  let send = Promise.resolve();
  const device = new SimDevice(
    {
      deviceId: 0x1a2b3c4d,
      runSeconds: 1250 * 3600,
      totalCount: 15000,
      pulsesPerSecond: 3.5,
      fitted: Device.eeprom | Device.rtc | Device.imu | Device.mag,
      rtcBattery: true,
      bluetoothSession: false,
      btPin: 1234,
      random,
    },
    realClock,
    (frame, _msg, periodic) => {
      if (periodic && !device.liveDataAllowed()) return;
      send = send.then(() => deviceSide.write(frame)).catch(() => {});
    },
  );
  const splitter = new FrameSplitter(
    (cmd) => device.onCommand(cmd),
    undefined,
    () => device.panicSignal(),
  );
  void (async () => {
    for await (const bytes of deviceSide.readable) splitter.push(bytes);
  })().catch(() => {});

  device.powerOn();
  const timer = setInterval(() => {
    engine.tick?.(realClock.nowMs(), device);
    device.poll();
  }, POLL_MS);

  return {
    readable: host.readable,
    write: (bytes) => host.write(bytes),
    close: () => {
      clearInterval(timer);
      host.close();
      deviceSide.close();
    },
  };
}
