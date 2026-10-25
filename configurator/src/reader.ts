// reader.ts: live view of everything the device sends, one line per frame.
//
//   hour-meter read [port | tcp://host:port] [--imu] [--no-time-sync] [--pin 1234] [--demo]
//   --imu           also print the IMU stream
//   --no-time-sync  do not send the PC clock when the device reports an unknown time
//                   (by default it does: needed when the RTC has no backup battery)
import { connect, connectHelp, DEFAULT_PORT, env, takeFlag, takeOption } from './cli.ts';
import type { DecodedMessage, SensorFrameError } from './sensorframe.ts';
import { bootText } from './restart.ts';
import { decodeStatusFlags, EVENT_KIND, MSG } from './tags.ts';

// Header timestamp is UTC epoch when timeValid, otherwise seconds since boot.
function when(msg: DecodedMessage): string {
  return msg.values.timeValid === false ? `uptime ${msg.timestamp}s` : new Date(msg.timestamp * 1000).toISOString();
}

/** Engine state; "input on" = the wire is live but runVibMinMg saw no engine vibration (firmware 2.5.0). */
export function engineText(v: DecodedMessage['values']): string {
  if (v.alternator) return 'ON ';
  return v.altInput ? 'OFF (input on)' : 'OFF';
}

export function formatTelemetry(msg: DecodedMessage): string {
  const v = msg.values;
  const imu =
    v.roll !== undefined
      ? ` roll ${v.roll}° pitch ${v.pitch}°${v.heading !== undefined ? ` heading ${v.heading}°` : ''}`
      : '';
  const vib = v.vibRms !== undefined ? ` vib ${v.vibRms}/${v.vibPeak} mg` : '';
  const flags = decodeStatusFlags(Number(v.statusFlags ?? 0));
  return (
    `${when(msg)} #${msg.seq} engine ${engineText(v)} run ${Number(v.runHours).toFixed(2)} h ` +
    `total ${v.totalCount}${imu}${vib}${flags.length ? ` [${flags.join(', ')}]` : ''}`
  );
}

/** `hour-meter read ...`: runs until Ctrl+C. */
export async function run(argv: string[]): Promise<number> {
  const pin = takeOption(argv, '--pin');
  const imu = takeFlag(pin.rest, '--imu');
  const noSync = takeFlag(imu.rest, '--no-time-sync');
  const demo = takeFlag(noSync.rest, '--demo');
  const port = demo.rest.find((a) => !a.startsWith('--')) ?? env('HOUR_METER_PORT') ?? DEFAULT_PORT;

  const dev = await connect({ demo: demo.value, port, pin: pin.value ?? env('HOUR_METER_PIN') }).catch((err) => {
    throw new Error(`${(err as Error).message}\n${connectHelp()}`);
  });
  if (!noSync.value) {
    dev
      .enableAutoTimeSync()
      .on('timeSynced', (e: number) =>
        console.log(`time sync: device clock set to ${new Date(e * 1000).toISOString()} (UTC)`),
      )
      .on('timeSyncError', (err: Error) => console.warn('time sync failed:', err.message));
  }
  dev.on('frame', (msg: DecodedMessage) => {
    if (msg.msgType === MSG.TELEMETRY) console.log(formatTelemetry(msg));
    else if (msg.msgType === MSG.EVENT) {
      const kind = EVENT_KIND[Number(msg.values.eventKind)] ?? msg.values.eventKind;
      const cause = kind === 'boot' ? ` (${bootText(msg.values)})` : '';
      console.log(`${when(msg)} EVENT ${kind}${cause}`, msg.values);
    } else if (msg.msgType === MSG.IMU && imu.value) console.log(`${when(msg)} IMU`, msg.values);
  });
  dev.on('frameError', (err: SensorFrameError) => console.warn('dropped frame:', err.code ?? err.message));
  return await new Promise<number>((resolve) => dev.once('close', () => resolve(0)));
}
