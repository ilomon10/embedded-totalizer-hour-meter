// Playground.tsx: the 3D route. Viewport on the left, inspector on the right
// (stacked on narrow screens). Dragging updates a local draft instantly and sends
// it to the simulator at most 20 times a second; the draft is dropped once the
// simulator's state has caught up.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ClientMessage, SimState } from '../../../src/web/messages.ts';
import type { Attitude } from './attitude3d.ts';
import { Inspector } from './Inspector.tsx';
import { type ChangePhase, Viewport } from './Viewport.tsx';

const SEND_EVERY_MS = 50;
const SETTLE_MS = 800;

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatches(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}

const same = (a: Attitude, b: Attitude) =>
  Math.abs(a.rollDeg - b.rollDeg) < 0.01 &&
  Math.abs(a.pitchDeg - b.pitchDeg) < 0.01 &&
  Math.abs(a.headingDeg - b.headingDeg) < 0.01;

export function Playground({ state, send }: { state: SimState; send: (msg: ClientMessage) => void }) {
  const dark = useMedia('(prefers-color-scheme: dark)');
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');
  const [draft, setDraft] = useState<Attitude | null>(null);
  const active = useRef(false);
  const lastSent = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const server: Attitude = state.values.motion;
  const attitude = draft ?? server;

  const push = useCallback(
    (a: Attitude) => {
      lastSent.current = performance.now();
      send({ type: 'set', group: 'motion', patch: { ...a } });
    },
    [send],
  );

  const change = useCallback(
    (next: Attitude, phase: ChangePhase) => {
      setDraft(next);
      clearTimeout(pending.current);
      clearTimeout(settle.current);
      active.current = phase === 'drag';
      if (phase !== 'drag') {
        push(next);
        settle.current = setTimeout(() => setDraft(null), SETTLE_MS); // never stick to a stale draft
        return;
      }
      const wait = SEND_EVERY_MS - (performance.now() - lastSent.current);
      if (wait <= 0) push(next);
      else pending.current = setTimeout(() => push(next), wait);
    },
    [push],
  );

  // Hand control back to the simulator's state once it shows what we sent.
  useEffect(() => {
    if (draft && !active.current && same(draft, server)) setDraft(null);
  }, [draft, server]);

  useEffect(
    () => () => {
      clearTimeout(pending.current);
      clearTimeout(settle.current);
    },
    [],
  );

  return (
    <div className="grid min-h-[calc(100dvh-4rem)] grid-cols-1 lg:h-[calc(100dvh-4rem)] lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="relative h-[58dvh] bg-[#eef1f3] lg:h-full dark:bg-[#12171c]">
        <Viewport
          attitude={attitude}
          vibrationRmsMg={state.values.vibration.rmsMg}
          onChange={change}
          dark={dark}
          reducedMotion={reducedMotion}
        />
        <p className="pointer-events-none absolute bottom-3 left-4 text-xs text-slate-500 dark:text-slate-400">
          Drag to tilt. Drag the ring to turn. Double-click to level.
        </p>
        {reducedMotion && state.values.vibration.rmsMg > 50 && (
          <p className="pointer-events-none absolute top-3 left-4 rounded-md bg-white/80 px-2 py-1 text-xs text-slate-700 dark:bg-slate-900/80 dark:text-slate-200">
            Vibrating at {Math.round(state.values.vibration.rmsMg)} mg RMS (shake hidden: reduced motion)
          </p>
        )}
      </div>
      <aside className="border-slate-200 bg-white lg:overflow-y-auto lg:border-l dark:border-slate-800 dark:bg-slate-900">
        <Inspector state={state} attitude={attitude} setAttitude={(a) => change(a, 'end')} send={send} />
      </aside>
    </div>
  );
}
