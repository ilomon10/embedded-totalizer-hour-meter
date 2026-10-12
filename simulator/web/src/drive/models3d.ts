// models3d.ts: the vehicles drawn on the map, built from simple shapes in metres.
// Model frame: x = right, y = forward (north at heading 0), z = up. The hour meter's
// board sits where a real install would: behind the truck cab, in the plane's cabin.
import {
  Box3,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Vector3,
} from 'three';

const mat = (color: string, roughness = 0.6, metalness = 0.1) =>
  new MeshStandardMaterial({ color, roughness, metalness });
const SIGNAL = '#ee6a1f';

function box(
  w: number,
  l: number,
  h: number,
  color: string,
  x: number,
  y: number,
  z: number,
  m?: MeshStandardMaterial,
) {
  const mesh = new Mesh(new BoxGeometry(w, l, h), m ?? mat(color));
  mesh.position.set(x, y, z + h / 2);
  return mesh;
}

function wheel(x: number, y: number) {
  const w = new Mesh(new CylinderGeometry(0.5, 0.5, 0.35, 20), mat('#1c1f22', 0.9));
  w.rotation.z = Math.PI / 2; // axle along x
  w.position.set(x, y, 0.5);
  return w;
}

/** A 2-axle tipper truck, about 8 m long (the hour meter's natural habitat). */
export function buildTruck(): Group {
  const g = new Group();
  g.add(box(2.4, 2.2, 2.3, '', 0, 2.7, 0.7, mat('#e8a33d', 0.5))); // cab
  g.add(box(2.2, 0.15, 1.0, '', 0, 3.85, 1.5, mat('#2a3138', 0.2, 0.4))); // windscreen
  g.add(box(2.5, 4.9, 1.6, '', 0, -0.9, 1.0, mat('#5b6670', 0.7))); // tipper body
  g.add(box(1.0, 7.6, 0.35, '', 0, 0.4, 0.55, mat('#2b2f33'))); // chassis
  g.add(box(0.5, 0.5, 0.18, '', 0, 1.25, 1.0, mat('#1e6b47'))); // the hour meter, behind the cab
  for (const y of [2.9, -1.8, -3.0]) for (const x of [-1.05, 1.05]) g.add(wheel(x, y));
  return g;
}

/** A small high-wing utility plane, about 11 m span. */
export function buildPlane(): Group {
  const g = new Group();
  const body = new Mesh(new CylinderGeometry(0.65, 0.35, 8, 20), mat('#f2f4f5', 0.4));
  body.rotation.x = Math.PI / 2; // cylinder axis along y (forward)
  body.position.set(0, 0, 1.6);
  g.add(body);
  const nose = new Mesh(new ConeGeometry(0.66, 1.2, 20), mat('#f2f4f5', 0.4));
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 4.6, 1.6);
  g.add(nose);
  g.add(box(11, 1.6, 0.15, '', 0, 0.8, 2.25, mat('#e6e9eb', 0.4))); // wing
  g.add(box(3.6, 0.9, 0.12, '', 0, -3.6, 1.7, mat('#e6e9eb', 0.4))); // tailplane
  g.add(box(0.12, 1.1, 1.5, '', 0, -3.7, 1.7, mat(SIGNAL, 0.4))); // fin
  g.add(box(1.0, 0.08, 1.0, '', 0, 5.25, 1.1, mat('#2b2f33'))); // propeller
  return g;
}

/**
 * Fit a loaded model into the vehicle frame: scale it to `lengthM` along its longest
 * horizontal side, centre it on the ground, then apply the user's axis fixes.
 */
export function fitModel(model: Object3D, lengthM: number, yawSteps: number, zUp: boolean): Group {
  const holder = new Group();
  const oriented = new Group();
  oriented.add(model);
  if (!zUp) oriented.rotation.x = Math.PI / 2; // glTF is Y-up: stand it on our z-up ground
  oriented.rotation.z = (yawSteps * Math.PI) / 2;
  oriented.updateMatrixWorld(true);
  const box3 = new Box3().setFromObject(oriented);
  const size = box3.getSize(new Vector3());
  const k = lengthM / Math.max(1e-6, size.x, size.y);
  oriented.scale.setScalar(k);
  oriented.updateMatrixWorld(true);
  const fitted = new Box3().setFromObject(oriented);
  const center = fitted.getCenter(new Vector3());
  oriented.position.set(-center.x, -center.y, -fitted.min.z);
  holder.add(oriented);
  return holder;
}

/** The forward marker under the vehicle: an orange chevron on the ground, visible from above. */
export function buildHeadingMarker(lengthM: number): Mesh {
  const m = new Mesh(new ConeGeometry(lengthM * 0.12, lengthM * 0.3, 3), mat(SIGNAL, 0.5));
  m.rotation.x = -Math.PI / 2;
  m.position.set(0, lengthM * 0.75, 0.05);
  m.scale.z = 0.15;
  return m;
}
