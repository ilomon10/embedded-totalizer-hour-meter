// Board.tsx: the hour-meter carrier PCB (rev A, 130 x 100 mm) as a simple model:
// solder mask, the plug-in modules, screw terminals, and an arrow on the board's
// x axis, the direction the firmware calls "forward" and measures heading on.
//
// Units: 1 = 50 mm. Board length (device x) runs along three -Z.
import { RoundedBox } from '@react-three/drei';

const MASK = '#1e6b47';
const ENIG = '#c8a04a';
const SIGNAL = '#ee6a1f';

/** A module or part: device-frame position in board units (x forward, y left), size w(x) d(y) h. */
function Part({
  x,
  y,
  w,
  d,
  h,
  color,
  rough = 0.6,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  color: string;
  rough?: number;
}) {
  return (
    <mesh position={[-y, 0.03 + h / 2, -x]} castShadow receiveShadow>
      <boxGeometry args={[d, h, w]} />
      <meshStandardMaterial color={color} roughness={rough} metalness={0.1} />
    </mesh>
  );
}

function ForwardArrow() {
  return (
    <group position={[0, 0.045, 0]}>
      <mesh position={[0, 0, -0.95]} rotation={[-Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.035, 0.035, 0.7, 16]} />
        <meshStandardMaterial color={SIGNAL} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0, -1.42]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.1, 0.26, 24]} />
        <meshStandardMaterial color={SIGNAL} roughness={0.4} />
      </mesh>
    </group>
  );
}

export function Board() {
  return (
    <group>
      <RoundedBox args={[2, 0.06, 2.6]} radius={0.03} smoothness={4} castShadow receiveShadow>
        <meshStandardMaterial color={MASK} roughness={0.45} metalness={0.05} />
      </RoundedBox>
      {/* ESP32 DevKit: dark module on headers, antenna toward the front edge */}
      <Part x={0.2} y={0.35} w={1.1} d={0.5} h={0.16} color="#20252b" rough={0.5} />
      <Part x={0.82} y={0.35} w={0.12} d={0.36} h={0.17} color="#d9dde0" rough={0.3} />
      {/* MPU9250 at the centre: the sensor this whole view is about */}
      <Part x={-0.1} y={-0.4} w={0.32} d={0.4} h={0.1} color="#6b3fa0" />
      <Part x={-0.1} y={-0.4} w={0.06} d={0.06} h={0.12} color="#15181b" />
      {/* DS3231 RTC with its coin cell, AT24C256 EEPROM */}
      <Part x={-0.75} y={-0.5} w={0.45} d={0.55} h={0.12} color="#1f4f9a" />
      <Part x={-0.75} y={-0.5} w={0.24} d={0.24} h={0.15} color="#c4c8cc" rough={0.25} />
      <Part x={0.55} y={-0.55} w={0.3} d={0.4} h={0.09} color="#1f4f9a" />
      {/* LM2596 buck module with its coil, 817 opto module */}
      <Part x={-0.85} y={0.4} w={0.85} d={0.42} h={0.08} color="#1f4f9a" />
      <Part x={-0.85} y={0.4} w={0.26} d={0.26} h={0.2} color="#2b2f33" />
      <Part x={-0.25} y={0.62} w={0.38} d={0.3} h={0.08} color="#1f4f9a" />
      {/* Screw terminals along the rear edge, pads in ENIG gold */}
      <Part x={-1.2} y={-0.3} w={0.16} d={0.7} h={0.2} color="#2e7d4f" />
      <Part x={-1.2} y={0.55} w={0.16} d={0.5} h={0.2} color="#2e7d4f" />
      <Part x={0.95} y={-0.55} w={0.08} d={0.5} h={0.02} color={ENIG} rough={0.25} />
      <ForwardArrow />
    </group>
  );
}
