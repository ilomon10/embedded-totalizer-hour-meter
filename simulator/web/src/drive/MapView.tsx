// MapView.tsx: the Drive map. OpenStreetMap tiles (a metric grid when offline), the
// route you edit, the true track, the dead-reckoning estimate, and the 3D vehicle.
//
// Editing: click the map to add a waypoint, drag one to move it, double-click to delete.
// The vehicle's pose arrives 10 times a second; between updates it is eased toward the
// latest pose so it glides instead of stepping (skipped under reduced motion).
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Object3D } from 'three';

import type { LatLon, TrackPoint, VehicleSnapshot, Waypoint } from '../../../src/web/messages.ts';
import { type Pose, VehicleLayer } from './vehicleLayer.ts';

const SIGNAL = '#ee6a1f';
const TRUTH = '#0f766e';
const ROUTE = '#0369a1';
const FOLLOW_LAMBDA = 4; // camera glide toward the vehicle, 1/s
const POSE_LAMBDA = 14; // vehicle glide toward the latest pose, 1/s

type Props = {
  vehicle: VehicleSnapshot | null;
  track: TrackPoint[];
  waypoints: Waypoint[];
  editing: boolean;
  placing: boolean;
  follow: boolean;
  model: Object3D;
  dark: boolean;
  reducedMotion: boolean;
  onAdd: (p: LatLon) => void;
  onMove: (index: number, p: LatLon) => void;
  onDelete: (index: number) => void;
  onPlace: (p: LatLon) => void;
  onUserPan: () => void;
};

const line = (coords: [number, number][]) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: { type: 'LineString' as const, coordinates: coords },
});
const points = (pts: Waypoint[]) => ({
  type: 'FeatureCollection' as const,
  features: pts.map((p, i) => ({
    type: 'Feature' as const,
    properties: { i, first: i === 0 ? 1 : 0 },
    geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
  })),
});

/** A metric-ish lat/lon grid around a point: what you see when the tiles can't load. */
function graticule(center: LatLon) {
  const step = 0.002; // about 220 m
  const lines: [number, number][][] = [];
  const lat0 = Math.round(center.lat / step) * step;
  const lon0 = Math.round(center.lon / step) * step;
  for (let i = -40; i <= 40; i++) {
    lines.push([
      [lon0 - 40 * step, lat0 + i * step],
      [lon0 + 40 * step, lat0 + i * step],
    ]);
    lines.push([
      [lon0 + i * step, lat0 - 40 * step],
      [lon0 + i * step, lat0 + 40 * step],
    ]);
  }
  return { type: 'FeatureCollection' as const, features: lines.map(line) };
}

const lerpAngle = (a: number, b: number, k: number) => a + (((b - a + 540) % 360) - 180) * k;

export function MapView(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const layerRef = useRef(new VehicleLayer());
  const latest = useRef(props);
  latest.current = props;
  const target = useRef<Pose | null>(null);
  const shown = useRef<Pose | null>(null);
  const dragging = useRef<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [ready, setReady] = useState(false);

  // Create the map once.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: host.current!,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 19,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#eef1f3' } },
          { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-opacity': 0.9 } },
        ],
      },
      center: [106.827, -6.1754],
      zoom: 15,
      pitch: 50,
      maxPitch: 70,
      doubleClickZoom: false,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    let tileErrors = 0;
    map.on('error', (e) => {
      if ((e as { sourceId?: string }).sourceId === 'osm' && ++tileErrors >= 3) setOffline(true);
    });
    map.on('load', () => {
      map.addSource('grid', { type: 'geojson', data: graticule({ lat: -6.1754, lon: 106.827 }) });
      map.addLayer({
        id: 'grid',
        type: 'line',
        source: 'grid',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#c7cfd5', 'line-width': 1 },
      });
      map.addSource('route', { type: 'geojson', data: line([]) });
      map.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        paint: { 'line-color': ROUTE, 'line-width': 3, 'line-opacity': 0.55, 'line-dasharray': [2, 1.5] },
      });
      map.addSource('truth', { type: 'geojson', data: line([]) });
      map.addLayer({
        id: 'truth',
        type: 'line',
        source: 'truth',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': TRUTH, 'line-width': 4 },
      });
      map.addSource('estimate', { type: 'geojson', data: line([]) });
      map.addLayer({
        id: 'estimate',
        type: 'line',
        source: 'estimate',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': SIGNAL, 'line-width': 3, 'line-dasharray': [1.5, 1.5] },
      });
      map.addSource('error', { type: 'geojson', data: line([]) });
      map.addLayer({
        id: 'error',
        type: 'line',
        source: 'error',
        paint: { 'line-color': SIGNAL, 'line-width': 1.5, 'line-opacity': 0.8 },
      });
      map.addSource('estimate-now', { type: 'geojson', data: points([]) });
      map.addLayer({
        id: 'estimate-now',
        type: 'circle',
        source: 'estimate-now',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-color': SIGNAL,
          'circle-stroke-width': 3,
        },
      });
      map.addSource('waypoints', { type: 'geojson', data: points([]) });
      map.addLayer({
        id: 'waypoints',
        type: 'circle',
        source: 'waypoints',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'first'], 1], 8, 6],
          'circle-color': '#ffffff',
          'circle-stroke-color': ROUTE,
          'circle-stroke-width': 3,
        },
      });
      map.addLayer(layerRef.current);
      setReady(true);
    });

    // Waypoint editing.
    map.on('mousedown', 'waypoints', (e) => {
      if (!latest.current.editing) return;
      e.preventDefault();
      dragging.current = Number(e.features?.[0]?.properties?.i);
      map.getCanvas().style.cursor = 'grabbing';
    });
    map.on('mousemove', (e) => {
      if (dragging.current === null) return;
      latest.current.onMove(dragging.current, { lat: e.lngLat.lat, lon: e.lngLat.lng });
    });
    map.on('mouseup', () => {
      if (dragging.current === null) return;
      dragging.current = null;
      map.getCanvas().style.cursor = '';
    });
    map.on('dblclick', 'waypoints', (e) => {
      if (!latest.current.editing) return;
      e.preventDefault();
      latest.current.onDelete(Number(e.features?.[0]?.properties?.i));
    });
    map.on('mouseenter', 'waypoints', () => {
      if (latest.current.editing) map.getCanvas().style.cursor = 'grab';
    });
    map.on('mouseleave', 'waypoints', () => {
      if (dragging.current === null) map.getCanvas().style.cursor = '';
    });
    map.on('click', (e) => {
      const p = latest.current;
      const onPoint = map.queryRenderedFeatures(e.point, { layers: ['waypoints'] }).length > 0;
      if (p.placing) p.onPlace({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      else if (p.editing && !onPoint) p.onAdd({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });
    map.on('dragstart', () => latest.current.onUserPan());

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Glide the vehicle and (when following) the camera toward the latest pose.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const map = mapRef.current;
      const t = target.current;
      if (map && t) {
        const p = latest.current;
        const s = shown.current && !p.reducedMotion ? shown.current : t;
        const k = 1 - Math.exp(-POSE_LAMBDA * dt);
        const next: Pose = p.reducedMotion
          ? t
          : {
              lat: s.lat + (t.lat - s.lat) * k,
              lon: s.lon + (t.lon - s.lon) * k,
              alt: s.alt + (t.alt - s.alt) * k,
              headingDeg: lerpAngle(s.headingDeg, t.headingDeg, k),
              pitchDeg: s.pitchDeg + (t.pitchDeg - s.pitchDeg) * k,
              rollDeg: s.rollDeg + (t.rollDeg - s.rollDeg) * k,
            };
        shown.current = next;
        layerRef.current.setPose(next);
        if (p.follow && dragging.current === null) {
          const c = map.getCenter();
          const kc = p.reducedMotion ? 1 : 1 - Math.exp(-FOLLOW_LAMBDA * dt);
          map.jumpTo({ center: [c.lng + (next.lon - c.lng) * kc, c.lat + (next.lat - c.lat) * kc] });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // New vehicle pose from the simulator.
  useEffect(() => {
    const v = props.vehicle;
    target.current = v
      ? {
          lat: v.truth.lat,
          lon: v.truth.lon,
          alt: v.truth.alt,
          headingDeg: v.truth.headingDeg,
          pitchDeg: v.truth.pitchDeg,
          rollDeg: v.truth.rollDeg,
        }
      : null;
    if (!v) {
      shown.current = null;
      layerRef.current.setPose(null);
    }
    const map = mapRef.current;
    if (!map || !ready) return;
    const est = v ? points([{ lat: v.estimate.lat, lon: v.estimate.lon }]) : points([]);
    (map.getSource('estimate-now') as GeoJSONSource).setData(est);
    (map.getSource('error') as GeoJSONSource).setData(
      v
        ? line([
            [v.truth.lon, v.truth.lat],
            [v.estimate.lon, v.estimate.lat],
          ])
        : line([]),
    );
  }, [props.vehicle, ready]);

  useEffect(() => {
    layerRef.current.setModel(props.model);
  }, [props.model]);

  // Tracks.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('truth') as GeoJSONSource).setData(line(props.track.map((p) => [p.lon, p.lat])));
    (map.getSource('estimate') as GeoJSONSource).setData(line(props.track.map((p) => [p.elon, p.elat])));
  }, [props.track, ready]);

  // Route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('waypoints') as GeoJSONSource).setData(points(props.waypoints));
    (map.getSource('route') as GeoJSONSource).setData(line(props.waypoints.map((w) => [w.lon, w.lat])));
  }, [props.waypoints, ready]);

  // Offline: hide the tiles, show the grid around the vehicle (or the map centre).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setLayoutProperty('osm', 'visibility', offline ? 'none' : 'visible');
    map.setLayoutProperty('grid', 'visibility', offline ? 'visible' : 'none');
    if (offline) {
      const c = props.vehicle?.truth ?? { lat: map.getCenter().lat, lon: map.getCenter().lng };
      (map.getSource('grid') as GeoJSONSource).setData(graticule(c));
    }
  }, [offline, ready, props.vehicle?.origin]);

  // Fly to a newly placed vehicle once.
  const placedAt = props.vehicle ? `${props.vehicle.origin.lat},${props.vehicle.origin.lon}` : '';
  useEffect(() => {
    const map = mapRef.current;
    const v = latest.current.vehicle;
    if (!map || !v) return;
    map.jumpTo({ center: [v.truth.lon, v.truth.lat], zoom: Math.max(map.getZoom(), v.kind === 'plane' ? 13 : 16) });
  }, [placedAt]);

  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = props.placing || props.editing ? 'crosshair' : '';
  }, [props.placing, props.editing]);

  return (
    <div className="relative h-full w-full">
      {/* h-full, not absolute: maplibre-gl.css sets position: relative on its container */}
      <div ref={host} className="h-full w-full" />
      {offline && (
        <p className="pointer-events-none absolute top-3 left-3 rounded-md bg-white/90 px-2 py-1 text-xs text-slate-700 shadow-sm dark:bg-slate-900/90 dark:text-slate-200">
          Map tiles can't load (offline?): showing a grid with lines about 220 m apart.
        </p>
      )}
    </div>
  );
}
