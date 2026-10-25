// modelStore.ts: your uploaded vehicle model, kept in this browser (IndexedDB) and
// never sent to the simulator. Load it with three.js' GLTFLoader (.glb and .gltf
// with embedded data). Storage can be unavailable (private windows): then the model
// just lasts until the page is closed.
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { VehicleKind } from '../../../src/web/messages.ts';

export interface CustomModel {
  name: string;
  data: ArrayBuffer;
  /** how it moves */
  kind: VehicleKind;
  lengthM: number;
  /** quarter turns about the vertical axis, to point its nose forward */
  yawSteps: number;
  /** true if the file is Z-up (most glTF files are Y-up) */
  zUp: boolean;
}

const DB = 'hour-meter-sim';
const STORE = 'models';
const KEY = 'custom';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveModel(m: CustomModel | null): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      if (m) tx.objectStore(STORE).put(m, KEY);
      else tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // storage unavailable: keep it for this visit only
  }
}

export async function loadSavedModel(): Promise<CustomModel | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as CustomModel | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export function parseModel(data: ArrayBuffer): Promise<Object3D> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      data,
      '',
      (gltf) => resolve(gltf.scene),
      (err) => reject(err),
    );
  });
}
