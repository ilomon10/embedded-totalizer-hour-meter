// vehicleLayer.ts: draws the vehicle into the MapLibre map with three.js (a custom
// layer, the pattern MapLibre documents for 3D models). The vehicle sits at its true
// latitude, longitude and height, turned by its true heading, pitch and roll.
//
// Angles use the firmware's conventions: heading clockwise from north, pitch positive
// = nose DOWN, roll positive = left side up. Model frame: x right, y forward, z up.
import maplibregl, { type CustomLayerInterface, type CustomRenderMethod, type Map as MapLibreMap } from 'maplibre-gl';
import {
  AmbientLight,
  Camera,
  DirectionalLight,
  Euler,
  Group,
  Matrix4,
  type Object3D,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

const DEG = Math.PI / 180;

export interface Pose {
  lat: number;
  lon: number;
  alt: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export class VehicleLayer implements CustomLayerInterface {
  readonly id = 'vehicle-3d';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map: MapLibreMap | null = null;
  private renderer: WebGLRenderer | null = null;
  private readonly camera = new Camera();
  private readonly scene = new Scene();
  private readonly body = new Group(); // oriented in east/north/up metres
  private pose: Pose | null = null;
  /** How much the model is enlarged at this zoom (1 = true size): see render(). */
  private enlarged = 1;

  constructor() {
    this.scene.add(new AmbientLight('#ffffff', 1.6));
    const sun = new DirectionalLight('#ffffff', 2.2);
    sun.position.set(30, -40, 80);
    this.scene.add(sun);
    this.scene.add(this.body);
  }

  setModel(model: Object3D): void {
    this.body.clear();
    this.body.add(model);
    this.map?.triggerRepaint();
  }

  setPose(pose: Pose | null): void {
    this.pose = pose;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  onRemove(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: Parameters<CustomRenderMethod>[1]): void {
    const pose = this.pose;
    if (!pose || !this.renderer || !this.map) return;
    const at = maplibregl.MercatorCoordinate.fromLngLat([pose.lon, pose.lat], pose.alt);
    const metre = at.meterInMercatorCoordinateUnits();
    // Keep the model at least ~40 px long at low zooms (a 1:1 truck is invisible at city scale).
    const pxPerM = 512 * 2 ** this.map.getZoom() * metre;
    const exaggerate = Math.max(1, 40 / (8 * pxPerM));
    this.enlarged = exaggerate;

    // ENU orientation: yaw (clockwise) -> pitch (nose down +) -> roll (left up +).
    this.body.quaternion.copy(
      new Quaternion().setFromEuler(new Euler(-pose.pitchDeg * DEG, pose.rollDeg * DEG, -pose.headingDeg * DEG, 'ZXY')),
    );
    this.body.scale.setScalar(exaggerate);
    // Mercator: x east, y SOUTH, z up, in mercator units: flip y and scale metres.
    const model = new Matrix4()
      .makeTranslation(at.x, at.y, at.z)
      .scale(new Vector3(metre, -metre, metre));
    this.camera.projectionMatrix = new Matrix4().fromArray(Array.from(matrix as ArrayLike<number>)).multiply(model);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  /** How much the model is enlarged right now (1 = true size). */
  enlargement(): number {
    return this.enlarged;
  }
}
