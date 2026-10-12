// Tag table shared by the examples. Mirror of the enum in the Arduino sketch:
// same number, same fmt. Add `scale` to turn scaled integers into real units.
module.exports = {
  1: { name: 'runSeconds', fmt: 'u32', unit: 's' },
  2: { name: 'totalCount', fmt: 'u32' },
  3: { name: 'alternator', fmt: 'bool' },
  4: { name: 'temperature', fmt: 'i16', scale: 0.1, unit: '°C' },
  100: { name: 'setCounter', fmt: 'u32' },
};
