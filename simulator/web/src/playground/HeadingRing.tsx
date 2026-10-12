// HeadingRing.tsx: a compass ring on the ground around the board. Drag along it
// to turn the heading. North is three -Z; the orange marker shows the board's
// heading as the host receives it.
import { useMemo, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { CanvasTexture, Plane, SRGBColorSpace, Vector3 } from 'three';

import { headingOfPoint } from './attitude3d.ts';

const RADIUS = 2.7;
const GROUND = -0.9;
const DEG = Math.PI / 180;
const ground = new Plane(new Vector3(0, 1, 0), -GROUND);
const hit = new Vector3();

/** A letter drawn into a texture: a sprite always faces the camera and needs no font download. */
function Letter({ text, color, position }: { text: string; color: string; position: [number, number, number] }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '600 40px "IBM Plex Sans Variable", system-ui, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 32, 34);
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, [text, color]);
  return (
    <sprite position={position} scale={0.32}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

function Tick({ deg, long, color }: { deg: number; long: boolean; color: string }) {
  const len = long ? 0.18 : 0.08;
  const r = RADIUS + 0.12 + len / 2;
  return (
    <mesh position={[Math.sin(deg * DEG) * r, GROUND, -Math.cos(deg * DEG) * r]} rotation={[0, -deg * DEG, 0]}>
      <boxGeometry args={[long ? 0.03 : 0.015, 0.005, len]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}

export function HeadingRing(
  { headingDeg, onDrag, onDragEnd, dark }: {
    headingDeg: number;
    onDrag: (headingDeg: number) => void;
    onDragEnd: () => void;
    dark: boolean;
  },
) {
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ink = dark ? '#8a97a3' : '#5f6c76';
  const ring = dragging || hover ? '#ee6a1f' : ink;

  const headingFrom = (e: ThreeEvent<PointerEvent>) =>
    e.ray.intersectPlane(ground, hit) ? headingOfPoint(hit.x, hit.z) : null;

  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, GROUND + 0.001, 0]}
        onPointerOver={() => setHover(true)}
        onPointerOut={() => setHover(false)}
        onPointerDown={(e) => {
          e.stopPropagation();
          (e.target as Element).setPointerCapture(e.pointerId);
          setDragging(true);
          const h = headingFrom(e);
          if (h !== null) onDrag(h);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          e.stopPropagation();
          const h = headingFrom(e);
          if (h !== null) onDrag(h);
        }}
        onPointerUp={(e) => {
          if (!dragging) return;
          (e.target as Element).releasePointerCapture(e.pointerId);
          setDragging(false);
          onDragEnd();
        }}
      >
        {/* Generous invisible hit band; the visible ring is the thin torus below */}
        <ringGeometry args={[RADIUS - 0.25, RADIUS + 0.35, 96]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, GROUND, 0]}>
        <torusGeometry args={[RADIUS, hover || dragging ? 0.018 : 0.01, 8, 128]} />
        <meshBasicMaterial color={ring} />
      </mesh>
      {Array.from({ length: 36 }, (_, i) => i * 10).map((deg) => (
        <Tick key={deg} deg={deg} long={deg % 90 === 0} color={deg === 0 ? '#ee6a1f' : ink} />
      ))}
      {(['N', 'E', 'S', 'W'] as const).map((label, i) => (
        <Letter
          key={label}
          text={label}
          color={label === 'N' ? '#ee6a1f' : ink}
          position={[
            Math.sin(i * 90 * DEG) * (RADIUS + 0.55),
            GROUND + 0.12,
            -Math.cos(i * 90 * DEG) * (RADIUS + 0.55),
          ]}
        />
      ))}
      {/* Current heading: a small triangle on the ring */}
      <mesh
        position={[
          Math.sin(headingDeg * DEG) * (RADIUS - 0.12),
          GROUND + 0.01,
          -Math.cos(headingDeg * DEG) * (RADIUS - 0.12),
        ]}
        rotation={[-Math.PI / 2, 0, -headingDeg * DEG]}
      >
        <circleGeometry args={[0.1, 3]} />
        <meshBasicMaterial color='#ee6a1f' />
      </mesh>
    </group>
  );
}

export const GROUND_Y = GROUND;
