// DrivePage.tsx: the Drive route. A vehicle carries the hour meter around a real map;
// the simulator turns its motion into IMU data, and a reference dead-reckoning
// estimate built only from what the host receives is drawn next to the truth.
//
// This component owns the page state (vehicle choice, the route being edited, live
// input) and talks to the simulator; MapView draws, DriveInspector presents.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Object3D } from 'three';

import type { ClientMessage, LatLon, SimState, TrackPoint, VehicleKind, Waypoint } from '../../../src/web/messages.ts';
import { parseTrack } from '../../../src/vehicle/tracks.ts';
import { distanceM } from '../../../src/vehicle/geo.ts';
import { firstPad, KeyboardDriver, loadMapping, type Mapping, readBinding } from './controls.ts';
import { DriveInspector, type Tab } from './DriveInspector.tsx';
import { MapView } from './MapView.tsx';
import { buildHeadingMarker, buildPlane, buildTruck, fitModel } from './models3d.ts';
import { type CustomModel, loadSavedModel, parseModel, saveModel } from './modelStore.ts';

const SEND_CONTROLS_MS = 50; // 20 Hz
const ROUTE_DEBOUNCE_MS = 300;

export type ModelChoice = 'truck' | 'plane' | 'custom';

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

const bearing = (a: LatLon, b: LatLon) => {
  const y = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  return ((Math.atan2(y, b.lat - a.lat) * 180) / Math.PI + 360) % 360;
};

export function DrivePage(
  { state, track, send }: { state: SimState; track: TrackPoint[]; send: (msg: ClientMessage) => void },
) {
  const vehicle = state.vehicle;
  const dark = useMedia('(prefers-color-scheme: dark)');
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');
  const [choice, setChoice] = useState<ModelChoice>(vehicle?.kind ?? 'truck');
  const [custom, setCustom] = useState<CustomModel | null>(null);
  const [customObject, setCustomObject] = useState<Object3D | null>(null);
  const [tab, setTab] = useState<Tab>('route');
  const [waypoints, setWaypoints] = useState<Waypoint[]>(vehicle?.route?.waypoints ?? []);
  const [speedKmh, setSpeedKmh] = useState(vehicle?.route ? Math.round(vehicle.route.speed * 3.6) : 36);
  const [altM, setAltM] = useState(vehicle?.route?.alt ?? 300);
  const [loop, setLoop] = useState(vehicle?.route?.loop ?? false);
  const [placing, setPlacing] = useState(!vehicle);
  const [follow, setFollow] = useState(true);
  const [mapping, setMapping] = useState<Mapping>(loadMapping);
  const [replayInfo, setReplayInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kind: VehicleKind = choice === 'custom' ? (custom?.kind ?? 'truck') : choice;

  // Keep the route speed inside what this vehicle can do (a plane can't fly at truck speeds).
  useEffect(() => {
    if (kind === 'plane' && speedKmh < 110) setSpeedKmh(200);
    if (kind === 'truck' && speedKmh > 90) setSpeedKmh(36);
  }, [kind]);
  const playing = vehicle?.playing ?? false;

  // The model drawn on the map.
  const model = useMemo(() => {
    const m = choice === 'custom' && customObject && custom
      ? fitModel(customObject.clone(), custom.lengthM, custom.yawSteps, custom.zUp)
      : choice === 'plane' || (choice === 'custom' && custom?.kind === 'plane')
      ? buildPlane()
      : buildTruck();
    m.add(buildHeadingMarker(kind === 'plane' ? 9 : 8));
    return m;
  }, [choice, customObject, custom, kind]);

  // Restore a previously uploaded model.
  useEffect(() => {
    loadSavedModel().then(async (saved) => {
      if (!saved) return;
      setCustom(saved);
      setCustomObject(await parseModel(saved.data).catch(() => null));
    });
  }, []);

  const placeAt = useCallback((origin: LatLon, headingDeg = 0) => {
    send({ type: 'vehicle', kind, origin, headingDeg });
    setPlacing(false);
  }, [kind, send]);

  // A different vehicle type at the same spot keeps the route (the server does that).
  const choose = (c: ModelChoice) => {
    setChoice(c);
    const k: VehicleKind = c === 'custom' ? (custom?.kind ?? 'truck') : c;
    if (vehicle && k !== vehicle.kind) send({ type: 'vehicle', kind: k });
  };

  // Send the edited route (debounced: dragging a point sends many changes).
  const routeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!vehicle) return;
    clearTimeout(routeTimer.current);
    routeTimer.current = setTimeout(() => {
      send({
        type: 'route',
        plan: waypoints.length >= 2 ? { waypoints, speed: speedKmh / 3.6, alt: altM, loop } : null,
      });
    }, ROUTE_DEBOUNCE_MS);
    return () => clearTimeout(routeTimer.current);
  }, [waypoints, speedKmh, altM, loop, vehicle !== null]);

  // Play from the first waypoint: move the vehicle there (facing the second) if it's far away.
  const play = () => {
    if (!vehicle || waypoints.length < 2) return;
    clearTimeout(routeTimer.current);
    const plan = { waypoints, speed: speedKmh / 3.6, alt: altM, loop };
    if (distanceM(vehicle.truth, waypoints[0]) > 30 && !vehicle.playing) {
      send({ type: 'vehicle', kind, origin: waypoints[0], headingDeg: bearing(waypoints[0], waypoints[1]) });
    }
    send({ type: 'route', plan });
    send({ type: 'play', action: 'play' });
  };

  // Live driving: keyboard + gamepad, sent at 20 Hz while the Live tab is open.
  const keyboard = useRef(new KeyboardDriver());
  useEffect(() => {
    if (tab !== 'live' || !vehicle) return;
    send({ type: 'drive-mode', mode: 'live' });
    const isTyping = (e: KeyboardEvent) =>
      e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.code === 'KeyR') return send({ type: 'anchor' });
      if (keyboard.current.key(e.code, true)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => keyboard.current.key(e.code, false);
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    let anchorWasDown = false;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const kb = keyboard.current.step((now - last) / 1000);
      last = now;
      const pad = firstPad();
      let controls = kb;
      if (pad && !keyboard.current.active()) {
        controls = {
          throttle: Math.max(0, readBinding(pad, mapping.throttle)),
          brake: Math.max(0, readBinding(pad, mapping.brake)),
          steer: readBinding(pad, mapping.steer),
          pitch: readBinding(pad, mapping.pitch),
        };
        const anchorDown = readBinding(pad, mapping.anchor) > 0.5;
        if (anchorDown && !anchorWasDown) send({ type: 'anchor' });
        anchorWasDown = anchorDown;
      }
      send({ type: 'controls', controls });
    }, SEND_CONTROLS_MS);
    return () => {
      clearInterval(timer);
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
    };
  }, [tab, vehicle !== null, mapping, send]);

  const changeTab = (t: Tab) => {
    setTab(t);
    if (vehicle && t !== 'live') send({ type: 'drive-mode', mode: 'route' });
  };

  const loadReplay = async (file: File) => {
    setError(null);
    try {
      const pts = parseTrack(file.name, await file.text());
      setWaypoints(pts);
      setLoop(false);
      const len = pts.slice(1).reduce((sum, p, i) => sum + distanceM(pts[i], p), 0);
      const timed = pts.some((p) => p.speed !== undefined);
      setReplayInfo(
        `${file.name}: ${pts.length} points, ${(len / 1000).toFixed(2)} km${timed ? ', with recorded speeds' : ''}`,
      );
      if (!vehicle) placeAt(pts[0], bearing(pts[0], pts[1]));
    } catch (err) {
      setError(`Couldn't read ${file.name}: ${(err as Error).message}`);
    }
  };

  const uploadModel = async (file: File) => {
    setError(null);
    try {
      const data = await file.arrayBuffer();
      const object = await parseModel(data);
      const m: CustomModel = {
        name: file.name,
        data,
        kind: custom?.kind ?? 'truck',
        lengthM: 8,
        yawSteps: 0,
        zUp: false,
      };
      setCustom(m);
      setCustomObject(object);
      setChoice('custom');
      await saveModel(m);
    } catch (err) {
      setError(`Couldn't load ${file.name} as glTF: ${(err as Error).message}`);
    }
  };

  const updateCustom = (patch: Partial<CustomModel>) => {
    if (!custom) return;
    const m = { ...custom, ...patch };
    setCustom(m);
    void saveModel(m);
    if (patch.kind && vehicle && patch.kind !== vehicle.kind) send({ type: 'vehicle', kind: patch.kind });
  };

  return (
    <div className='grid min-h-[calc(100dvh-4rem)] grid-cols-1 lg:h-[calc(100dvh-4rem)] lg:grid-cols-[minmax(0,1fr)_24rem]'>
      <div className='relative h-[60dvh] lg:h-full'>
        <MapView
          vehicle={vehicle}
          track={track}
          waypoints={waypoints}
          editing={(tab === 'route' || tab === 'replay') && !playing && !placing}
          placing={placing}
          follow={follow}
          model={model}
          dark={dark}
          reducedMotion={reducedMotion}
          onAdd={(p) => setWaypoints((w) => [...w, p])}
          onMove={(i, p) => setWaypoints((w) => w.map((x, j) => (j === i ? { ...x, ...p } : x)))}
          onDelete={(i) => setWaypoints((w) => w.filter((_, j) => j !== i))}
          onPlace={(p) => placeAt(p, waypoints.length >= 2 ? bearing(waypoints[0], waypoints[1]) : 0)}
          onUserPan={() => setFollow(false)}
        />
        <div className='pointer-events-none absolute bottom-8 left-3 flex flex-col gap-1 text-xs'>
          {placing && (
            <span className='rounded-md bg-white/90 px-2 py-1 text-slate-800 shadow-sm dark:bg-slate-900/90 dark:text-slate-100'>
              Click the map where the {kind} starts.
            </span>
          )}
          {!placing && (tab === 'route' || tab === 'replay') && !playing && (
            <span className='rounded-md bg-white/90 px-2 py-1 text-slate-700 shadow-sm dark:bg-slate-900/90 dark:text-slate-200'>
              Click to add a waypoint. Drag to move one, double-click to delete it.
            </span>
          )}
        </div>
      </div>
      <aside className='border-slate-200 bg-white lg:overflow-y-auto lg:border-l dark:border-slate-800 dark:bg-slate-900'>
        <DriveInspector
          state={state}
          send={send}
          choice={choice}
          onChoose={choose}
          custom={custom}
          onUploadModel={uploadModel}
          onUpdateCustom={updateCustom}
          placing={placing}
          onPlace={() => setPlacing(true)}
          onStopDriving={() => {
            send({ type: 'vehicle', kind: null });
            setPlacing(true);
          }}
          tab={tab}
          onTab={changeTab}
          waypoints={waypoints}
          onClearRoute={() => setWaypoints([])}
          speedKmh={speedKmh}
          onSpeed={setSpeedKmh}
          altM={altM}
          onAlt={setAltM}
          loop={loop}
          onLoop={setLoop}
          onPlay={play}
          follow={follow}
          onFollow={setFollow}
          mapping={mapping}
          onMapping={setMapping}
          replayInfo={replayInfo}
          onReplayFile={loadReplay}
          error={error}
        />
      </aside>
    </div>
  );
}
