// route.ts: drive a vehicle along waypoints with the same controls a person would
// use (pure pursuit for steering, a speed controller for throttle and brake), so
// route playback produces physical motion and honest IMU data, never a teleport.
import { type LatLon, LocalFrame } from './geo.ts';
import { type Controls, Plane, Truck, type VehicleKind, type VehicleState } from './models.ts';

const G = 9.80665;
const DEG = Math.PI / 180;

export interface Waypoint extends LatLon {
  /** target speed toward this point, m/s (timed tracks set it per point) */
  speed?: number;
}

export interface RoutePlan {
  waypoints: Waypoint[];
  /** default target speed, m/s */
  speed: number;
  /** plane: default height above the start, m */
  alt?: number;
  loop: boolean;
}

interface Point {
  e: number;
  n: number;
  u?: number;
  speed?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrap180 = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

export class RouteFollower {
  private readonly points: Point[];
  /** path length from each point to the end, m */
  private readonly toEnd: number[];
  private segment = 0;
  done = false;

  constructor(frame: LocalFrame, private readonly plan: RoutePlan, private readonly kind: VehicleKind) {
    const pts = plan.waypoints.map((w) => ({ ...frame.toEnu(w), u: w.alt, speed: w.speed }));
    if (plan.loop && pts.length > 2) pts.push(pts[0]);
    this.points = pts;
    this.toEnd = pts.map(() => 0);
    for (let i = pts.length - 2; i >= 0; i--) {
      this.toEnd[i] = this.toEnd[i + 1] + Math.hypot(pts[i + 1].e - pts[i].e, pts[i + 1].n - pts[i].n);
    }
    if (pts.length < 2) this.done = true;
  }

  private lookahead(speed: number): number {
    return this.kind === 'plane' ? Math.max(180, speed * 5) : Math.max(8, speed * 1.4);
  }

  private arriveRadius(): number {
    return this.kind === 'plane' ? 150 : 6;
  }

  /** The point `distance` metres further along the path than the vehicle's projection. */
  private target(s: VehicleState, distance: number): { e: number; n: number; remaining: number } {
    const pts = this.points;
    // Move on to the next segment once its start (this segment's end) is passed, or is
    // inside the lookahead: a wide-turning vehicle cuts corners and never "passes" them.
    while (this.segment < pts.length - 2) {
      const a = pts[this.segment];
      const b = pts[this.segment + 1];
      const along = ((s.e - a.e) * (b.e - a.e) + (s.n - a.n) * (b.n - a.n)) /
        Math.max(1e-6, (b.e - a.e) ** 2 + (b.n - a.n) ** 2);
      if (along < 1 && Math.hypot(b.e - s.e, b.n - s.n) > distance * 0.9) break;
      this.segment++;
    }
    let i = this.segment;
    let a = pts[i];
    let b = pts[i + 1];
    const len = Math.hypot(b.e - a.e, b.n - a.n);
    const t = clamp(((s.e - a.e) * (b.e - a.e) + (s.n - a.n) * (b.n - a.n)) / Math.max(1e-6, len * len), 0, 1);
    let left = distance;
    let pe = a.e + (b.e - a.e) * t;
    let pn = a.n + (b.n - a.n) * t;
    let seg = len * (1 - t);
    while (left > seg && i < pts.length - 2) {
      left -= seg;
      i++;
      a = pts[i];
      b = pts[i + 1];
      pe = a.e;
      pn = a.n;
      seg = Math.hypot(b.e - a.e, b.n - a.n);
    }
    const k = seg > 0 ? Math.min(1, left / seg) : 1;
    // Distance left ALONG the path (a closed loop ends where it starts: straight-line would say 0).
    const cur = this.segment;
    const segLen = Math.hypot(pts[cur + 1].e - pts[cur].e, pts[cur + 1].n - pts[cur].n);
    const remaining = segLen * (1 - t) + this.toEnd[cur + 1];
    return { e: pe + (b.e - pe) * k, n: pn + (b.n - pn) * k, remaining };
  }

  /** Controls for this moment. Sets `done` when the last point is reached (and restarts loops). */
  controls(s: VehicleState): Controls {
    if (this.done) return { throttle: 0, brake: 1, steer: 0, pitch: 0 };
    const ld = this.lookahead(s.speed);
    const tgt = this.target(s, ld);
    const last = this.segment >= this.points.length - 2;
    if (last && tgt.remaining < this.arriveRadius()) {
      if (this.plan.loop && this.points.length > 2) this.segment = 0;
      else if (this.kind === 'plane' || s.speed < 0.5) {
        this.done = true; // a plane flies on; a truck finishes once it has stopped
        return { throttle: 0, brake: 1, steer: 0, pitch: 0 };
      } else return { throttle: 0, brake: 0.6, steer: 0, pitch: 0 };
    }
    // Pure pursuit: curvature toward the lookahead point.
    const bearing = Math.atan2(tgt.e - s.e, tgt.n - s.n) / DEG;
    const alpha = wrap180(bearing - s.headingDeg) * DEG; // + = target to the right
    const dist = Math.max(1, Math.hypot(tgt.e - s.e, tgt.n - s.n));
    const curvature = (2 * Math.sin(alpha)) / dist;
    const next = this.points[Math.min(this.segment + 1, this.points.length - 1)];
    let speed = next.speed ?? this.plan.speed;
    if (this.kind === 'truck') {
      speed = Math.min(speed, Math.sqrt(2.5 / Math.max(1e-4, Math.abs(curvature)))); // keep lateral accel under 2.5 m/s²
      if (!this.plan.loop) speed = Math.min(speed, Math.sqrt(2 * 1.5 * Math.max(0, tgt.remaining - 2))); // ease into the end
      const steerDeg = Math.atan(Truck.WHEELBASE_M * curvature) / DEG;
      const err = speed - s.speed;
      return {
        throttle: clamp(err * 0.6, 0, 1),
        brake: clamp(-err * 0.4, 0, 1),
        steer: clamp(steerDeg / Truck.MAX_STEER_DEG, -1, 1),
        pitch: 0,
      };
    }
    const bankDeg = Math.atan((s.speed * s.speed * curvature) / G) / DEG;
    const alt = next.u ?? this.plan.alt ?? s.u;
    const gammaDeg = clamp((alt - s.u) * 0.08, -Plane.MAX_GAMMA_DEG, Plane.MAX_GAMMA_DEG);
    const err = clamp(speed, Plane.STALL + 2, Plane.MAX_SPEED) - s.speed;
    return {
      throttle: clamp(0.35 + err * 0.15, 0, 1),
      brake: clamp(-err * 0.1, 0, 1),
      steer: clamp(bankDeg / Plane.MAX_BANK_DEG, -1, 1),
      pitch: gammaDeg / Plane.MAX_GAMMA_DEG,
    };
  }
}
