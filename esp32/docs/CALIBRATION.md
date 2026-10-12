# IMU Calibration and Filtering

How raw MPU9250 readings become vibration, orientation and heading, and how to calibrate and tune them. Operator steps are also in the [integration guide](INTEGRATION-GUIDE.md#calibration-procedure).

## Why calibrate

| Error | Effect if uncorrected | Fixed by |
|---|---|---|
| Accelerometer offset (bias) | Roll/pitch off by a few degrees | `calibrate` 1 |
| Gyro offset (bias) | Roll/pitch drift between corrections | `calibrate` 1 (and learned online by KalmanAngle) |
| Sensor noise level | Kalman filter tuned wrong (too smooth or too noisy) | `calibrate` 1 measures it (R) |
| Hard iron (magnets, steel near the board) | Heading wrong by tens of degrees | `calibrate` 2 |
| Soft iron (stretched field) | Heading error depends on direction | `calibrate` 2 |

**Calibrate on the installed machine.** The steel around it is part of what the magnetometer calibration corrects.

## Calibration 1: accelerometer + gyro (at rest)

1. Place the device flat, z axis up, completely still (engine off).
2. Send `calibrate=1`.
3. The firmware collects 512 samples (about 5 s at 100 Hz) using **running statistics**: mean and variance are updated per sample, and nothing is stored.
4. Checks: mean accel z within 0.9–1.1 g and |x|, |y| < 0.1 g (flat); gyro variance < 1 (°/s)² (still).
5. Results, saved in Settings:
   - `accelBias = mean − (0, 0, 1 g)`
   - `gyroBias = mean`
   - `accelNoiseVar`, `gyroNoiseVar` = variance, which become the Kalman measurement noise **R**

## Calibration 2: magnetometer (rotate)

1. Send `calibrate=2`.
2. For 20 s, slowly rotate the device through every orientation (figure-eight, each axis up and down).
3. The firmware tracks the min and max of each axis.
4. Checks: at least 100 samples, and every axis swung ≥ 20 µT (Earth's field is about 25–65 µT).
5. Results: `offset = (max + min) / 2` (hard iron) and `scale = avgRadius / radius_axis` (soft iron, diagonal approximation).

## The filters

| Output | Filter | Tuning |
|---|---|---|
| Filtered accel / gyro / mag | `Kalman1D` per axis (random-walk model) | **R** from calibration; **Q** = settings `kalmanQAccel/Gyro/Mag`. Raise Q for faster response, lower it for smoother output |
| Roll, pitch | `KalmanAngle`: accel angle + gyro rate, state = angle + gyro bias | Built-in Q/R (0.001 / 0.003 / 0.03), the standard values for MPU-class sensors |
| Heading | Vector method: `east = mag × up`, `north = up × east` | Needs mag calibration; `up` comes from filtered roll/pitch (tilt compensation) |
| Vibration RMS / peak | Gravity removed by a 0.5 Hz low-pass tracker, then RMS / peak of \|a\| over a window | `vibrationWindowMs`. Uses the **unfiltered** signal on purpose |

### Why the Kalman filter needs no stored history

A Kalman filter is *recursive*: it keeps only its current estimate and that estimate's uncertainty (2 numbers per axis), and updates them with each new sample. All the information from past samples is already summarised in those two numbers. That is why nothing is logged to the EEPROM for filtering: it would only wear the chip out. The only persisted inputs are the calibration results (R, biases) and Q.

### Limits to know

- **Heading under acceleration.** Tilt compensation uses gravity, so hard braking or cornering briefly tilts the computed "up" and disturbs the heading.
- **Heading near motors and alternators.** Changing currents create fields that calibration cannot remove. Mount the device away from cables carrying high current.
- **Magnetic north.** Declination is not applied (it is a few degrees across Indonesia). Add it in the app if true north is needed.
- **Speed is not computed.** Integrating acceleration drifts within seconds. Use a wheel or VSS pulse sensor (the pulse input can count it) or GPS.
- **±4 g / ±500 °/s range.** Impacts beyond that clip and set the `imuSaturated` flag.
