import { z } from 'zod';

import type { SceneDocument } from '@/lib/studio-types';

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const material = z.object({
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  roughness: z.number().min(0).max(1),
  metalness: z.number().min(0).max(1),
  wireframe: z.boolean(),
});
const objectSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(80),
  type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus', 'group', 'glb']),
  position: vec3,
  rotation: vec3,
  scale: vec3.refine((values) => values.every((value) => value > 0 && value <= 1000), 'Scale must be positive.'),
  parentId: z.string().nullable(),
  material,
  assetDataUrl: z.string().startsWith('data:model/gltf-binary;base64,').optional(),
});
const sceneSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  title: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  objects: z.array(objectSchema).max(500),
  settings: z.object({ gridSize: z.number().positive(), snapEnabled: z.boolean() }),
}).superRefine((doc, context) => {
  const ids = new Set(doc.objects.map((object) => object.id));
  if (ids.size !== doc.objects.length) context.addIssue({ code: 'custom', message: 'Object IDs must be unique.' });
  doc.objects.forEach((object, index) => {
    if (object.parentId && !ids.has(object.parentId)) context.addIssue({ code: 'custom', path: ['objects', index, 'parentId'], message: 'Parent object was not found.' });
    if (object.parentId === object.id) context.addIssue({ code: 'custom', path: ['objects', index, 'parentId'], message: 'An object cannot parent itself.' });
    if (object.type === 'glb' && !object.assetDataUrl) context.addIssue({ code: 'custom', path: ['objects', index, 'assetDataUrl'], message: 'Imported models require embedded GLB data.' });
  });
});

export function validateSceneDocument(value: unknown): SceneDocument {
  return sceneSchema.parse(value) as SceneDocument;
}

const DB_NAME = 'model-room';
const STORE_NAME = 'projects';
const KEY = 'current-scene';

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
  });
}

export async function loadLocalScene(): Promise<SceneDocument | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return value ? validateSceneDocument(value) : null;
  } finally {
    database.close();
  }
}

export async function saveLocalScene(doc: SceneDocument) {
  if (typeof indexedDB === 'undefined') return;
  const validated = validateSceneDocument(doc);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(validated, KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export function downloadJson(doc: SceneDocument) {
  const blob = new Blob([JSON.stringify(validateSceneDocument(doc), null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${safeFilename(doc.title)}.model-room.json`);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function safeFilename(value: string) {
  return value.trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'model-room-project';
}

export async function readJsonProject(file: File) {
  if (file.size > 35 * 1024 * 1024) throw new Error('Project files must be 35 MB or smaller.');
  const parsed = JSON.parse(await file.text()) as unknown;
  return validateSceneDocument(parsed);
}

export function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
