// Viewport.tsx: the 3D canvas. Drag the board area to tilt (left/right = roll,
// up/down = pitch), drag the ring to turn the heading, double-click to level.
// With the canvas focused: arrow keys nudge roll/pitch by 1° (Shift: 10°), [ and ] turn
// the heading. Keyboard changes apply instantly; pointer changes are followed by a spring.
import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Grid } from '@react-three/drei';
import { type Group, Quaternion, Vector3 } from 'three';

import { type Attitude, attitudeToQuaternion, clampPitch, follow, wrapHeading, wrapRoll } from './attitude3d.ts';
import { Board } from './Board.tsx';
import { GROUND_Y, HeadingRing } from './HeadingRing.tsx';

const DEG_PER_PX = 0.35;
const FOLLOW_DRAGGING = 28; // track the pointer closely
const FOLLOW_RESTING = 9; // glide between the 5 Hz state updates

const CAMERA = new Vector3(5.6, 6.2, 8.2);
const LOOK_AT = new Vector3(0, -0.6, 0);
const WIDE_ASPECT = 0.95; // at this aspect or wider, the whole ring fits at CAMERA's distance

/** Back the camera off on narrow viewports (phones, portrait) so the ring always fits. */
function FitCamera() {
  const { camera, size } = useThree();
  useEffect(() => {
    const k = Math.max(1, WIDE_ASPECT / (size.width / size.height));
    camera.position.copy(LOOK_AT).add(CAMERA.clone().sub(LOOK_AT).multiplyScalar(k));
    camera.lookAt(LOOK_AT);
  }, [camera, size.width, size.height]);
  return null;
}

export type ChangePhase = 'drag' | 'end' | 'instant';

interface Props {
  attitude: Attitude;
  vibrationRmsMg: number;
  onChange: (next: Attitude, phase: ChangePhase) => void;
  dark: boolean;
  reducedMotion: boolean;
}

function FollowingBoard(
  { attitude, dragging, snap, vibrationRmsMg, reducedMotion }: {
    attitude: Attitude;
    dragging: React.RefObject<boolean>;
    snap: React.RefObject<boolean>;
    vibrationRmsMg: number;
    reducedMotion: boolean;
  },
) {
  const turn = useRef<Group>(null);
  const shake = useRef<Group>(null);
  const target = useRef(new Quaternion());
  attitudeToQuaternion(attitude, target.current);

  useFrame((_, dt) => {
    const g = turn.current;
    if (!g) return;
    if (snap.current) {
      g.quaternion.copy(target.current);
      snap.current = false;
    } else {
      follow(g.quaternion, target.current, dragging.current ? FOLLOW_DRAGGING : FOLLOW_RESTING, Math.min(dt, 0.05));
    }
    // Vibration: random jitter scaled by the RMS level (1 g RMS -> 0.06 units). Off for reduced motion.
    const s = shake.current;
    if (!s) return;
    const amp = reducedMotion ? 0 : Math.min(0.08, (vibrationRmsMg / 1000) * 0.06);
    const n = () => (Math.random() - 0.5) * 2 * amp;
    s.position.set(n(), n() * 0.6, n());
    s.rotation.set(n() * 0.4, 0, n() * 0.4);
  });

  return (
    <group ref={turn}>
      <group ref={shake}>
        <Board />
      </group>
    </group>
  );
}

export function Viewport({ attitude, vibrationRmsMg, onChange, dark, reducedMotion }: Props) {
  const dragging = useRef(false);
  const ringActive = useRef(false);
  const snap = useRef(false);
  const start = useRef<{ x: number; y: number; attitude: Attitude } | null>(null);
  const latest = useRef(attitude);
  latest.current = attitude;
  const host = useRef<HTMLDivElement>(null);

  // Keyboard nudges snap: a keyboard action must never wait for an animation.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 10 : 1;
      const a = latest.current;
      const next: Record<string, Attitude> = {
        ArrowLeft: { ...a, rollDeg: wrapRoll(a.rollDeg - step) },
        ArrowRight: { ...a, rollDeg: wrapRoll(a.rollDeg + step) },
        ArrowUp: { ...a, pitchDeg: clampPitch(a.pitchDeg - step) }, // nose up
        ArrowDown: { ...a, pitchDeg: clampPitch(a.pitchDeg + step) },
        '[': { ...a, headingDeg: wrapHeading(a.headingDeg - step) },
        ']': { ...a, headingDeg: wrapHeading(a.headingDeg + step) },
      };
      if (!(e.key in next)) return;
      e.preventDefault();
      snap.current = true;
      onChange(next[e.key], 'instant');
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onChange]);

  return (
    <div
      ref={host}
      tabIndex={0}
      aria-label='3D board. Drag to tilt, drag the ring to turn, double-click to level. Arrow keys and [ ] nudge.'
      className='relative h-full w-full cursor-grab touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset'
      onPointerDown={(e) => {
        if (ringActive.current || e.button !== 0) return; // the ring handles its own drag
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY, attitude: latest.current };
        dragging.current = true;
        e.currentTarget.style.cursor = 'grabbing';
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        onChange({
          ...s.attitude,
          rollDeg: wrapRoll(s.attitude.rollDeg + (e.clientX - s.x) * DEG_PER_PX),
          pitchDeg: clampPitch(s.attitude.pitchDeg + (e.clientY - s.y) * DEG_PER_PX), // drag up = nose up = negative pitch
        }, 'drag');
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        start.current = null;
        dragging.current = false;
        e.currentTarget.style.cursor = '';
        onChange(latest.current, 'end');
      }}
      onDoubleClick={() => onChange({ ...latest.current, rollDeg: 0, pitchDeg: 0 }, 'end')}
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [5.6, 6.2, 8.2], fov: 30 }}
      >
        <FitCamera />
        <hemisphereLight args={[dark ? '#9fb3c4' : '#ffffff', dark ? '#1a2128' : '#b9c2c8', dark ? 1.1 : 1.4]} />
        <directionalLight position={[3, 6, 2]} intensity={dark ? 1.6 : 2.2} castShadow shadow-mapSize={[1024, 1024]} />
        <FollowingBoard
          attitude={attitude}
          dragging={dragging}
          snap={snap}
          vibrationRmsMg={vibrationRmsMg}
          reducedMotion={reducedMotion}
        />
        <HeadingRing
          headingDeg={attitude.headingDeg}
          dark={dark}
          onDrag={(headingDeg) => {
            ringActive.current = true;
            dragging.current = true;
            onChange({ ...latest.current, headingDeg }, 'drag');
          }}
          onDragEnd={() => {
            ringActive.current = false;
            dragging.current = false;
            onChange(latest.current, 'end');
          }}
        />
        <ContactShadows position={[0, GROUND_Y, 0]} scale={6} blur={2.4} opacity={dark ? 0.6 : 0.35} far={3} />
        <Grid
          position={[0, GROUND_Y - 0.002, 0]}
          args={[20, 20]}
          cellSize={0.25}
          sectionSize={1}
          cellThickness={0.6}
          sectionThickness={1}
          cellColor={dark ? '#26313a' : '#d3d9dd'}
          sectionColor={dark ? '#34424e' : '#bcc5cb'}
          fadeDistance={11}
          fadeStrength={1.6}
          infiniteGrid
        />
      </Canvas>
    </div>
  );
}
