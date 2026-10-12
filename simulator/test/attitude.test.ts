// attitude.test.ts: sensor vectors for an attitude decode back to that attitude
// with the firmware's own formulas (Orientation.h, Compass.h).
import { assert } from './assert.ts';
import { headingFromMag, pitchFromAccel, rollFromAccel, sensorVectors } from '../src/attitude.ts';

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const angleClose = (a: number, b: number) => close(((a - b + 540) % 360) - 180, 0);

Deno.test('roll, pitch and heading survive the trip through the sensors', () => {
  for (const roll of [-170, -45, 0, 12.34, 89, 135]) {
    for (const pitch of [-80, -5.5, 0, 30, 80]) {
      for (const heading of [0, 33.5, 90, 180, 270, 359]) {
        const { accelG, magUt } = sensorVectors(roll, pitch, heading);
        assert(close(rollFromAccel(accelG), roll), `roll ${roll} (pitch ${pitch})`);
        assert(close(pitchFromAccel(accelG), pitch), `pitch ${pitch}`);
        assert(angleClose(headingFromMag(magUt, accelG), heading), `heading ${heading} at ${roll}/${pitch}`);
      }
    }
  }
});

Deno.test('a level board facing north reads +1 g on z and a north + down field', () => {
  const { accelG, magUt } = sensorVectors(0, 0, 0);
  assert(close(accelG.z, 1) && close(accelG.x, 0) && close(accelG.y, 0));
  assert(close(magUt.x, 30) && close(magUt.y, 0) && close(magUt.z, -40));
});
