// run-confirm.ts: "is the engine really running?" from the IMU's vibration.
// Port of esp32/lib/App/src/RunConfirm.h (firmware 2.5.0).
//
//   minMg == 0          -> always confirmed (feature off, the input alone decides)
//   no IMU              -> always confirmed (never lose hours to an unplugged IMU)
//   no vibration window -> not confirmed yet
//   otherwise           -> confirmed at rms >= minMg, released below 70 % of it
export const RELEASE_PERCENT = 70;

export class RunConfirm {
  private confirmedNow = false;

  update(imuPresent: boolean, hasVibration: boolean, rmsMg: number, minMg: number): boolean {
    if (minMg === 0 || !imuPresent) {
      this.confirmedNow = true;
    } else if (!hasVibration) {
      this.confirmedNow = false;
    } else if (rmsMg >= minMg) {
      this.confirmedNow = true;
    } else if (rmsMg < Math.fround((minMg * RELEASE_PERCENT) / 100)) {
      this.confirmedNow = false;
    }
    return this.confirmedNow;
  }

  confirmed(): boolean {
    return this.confirmedNow;
  }
}
