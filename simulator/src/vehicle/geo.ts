// geo.ts: latitude/longitude <-> local east/north/up metres around an origin.
//
// A local tangent plane with the WGS-84 radii of curvature at the origin. Over the
// few kilometres a simulated drive covers, the error stays well under a metre,
// far below the dead-reckoning drift this simulator exists to show.

export interface LatLon {
  lat: number;
  lon: number;
  /** metres above the origin's height (not sea level) */
  alt?: number;
}

export interface Enu {
  e: number;
  n: number;
  u: number;
}

const A = 6378137; // WGS-84 semi-major axis, m
const E2 = 6.69437999014e-3; // first eccentricity squared
const DEG = Math.PI / 180;

export class LocalFrame {
  private readonly mPerDegLat: number;
  private readonly mPerDegLon: number;

  constructor(readonly origin: LatLon) {
    const s = Math.sin(origin.lat * DEG);
    const w = Math.sqrt(1 - E2 * s * s);
    const meridian = (A * (1 - E2)) / (w * w * w); // radius of curvature north-south
    const prime = A / w; // east-west
    this.mPerDegLat = meridian * DEG;
    this.mPerDegLon = prime * Math.cos(origin.lat * DEG) * DEG;
  }

  toEnu(p: LatLon): Enu {
    return {
      e: (p.lon - this.origin.lon) * this.mPerDegLon,
      n: (p.lat - this.origin.lat) * this.mPerDegLat,
      u: p.alt ?? 0,
    };
  }

  toLatLon(p: Enu): Required<LatLon> {
    return { lat: this.origin.lat + p.n / this.mPerDegLat, lon: this.origin.lon + p.e / this.mPerDegLon, alt: p.u };
  }
}

/** Great-circle distance in metres (haversine), for track lengths and replay speeds. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
