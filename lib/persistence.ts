import { z } from 'zod';

import { DEFAULT_GEOMETRY, DEFAULT_MATERIAL, type SceneDocument } from '@/lib/studio-types';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const embeddedImage = z.string().startsWith('data:image/').max(8_000_000).optional();
const material = z.object({
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  roughness: z.number().min(0).max(1),
  metalness: z.number().min(0).max(1),
  wireframe: z.boolean(),
  opacity: z.number().min(0).max(1),
  emissive: z.string().regex(/^#[0-9a-f]{6}$/i),
  emissiveIntensity: z.number().min(0).max(10),
  baseColorTexture: embeddedImage,
  normalTexture: embeddedImage,
  roughnessTexture: embeddedImage,
  metalnessTexture: embeddedImage,
});
const geometry = z.object({
  width: z.number().positive().max(1000),
  height: z.number().positive().max(1000),
  depth: z.number().positive().max(1000),
  radius: z.number().positive().max(1000),
  radiusTop: z.number().positive().max(1000),
  radiusBottom: z.number().positive().max(1000),
  tube: z.number().positive().max(1000),
  radialSegments: z.number().int().min(3).max(256),
  heightSegments: z.number().int().min(1).max(128),
}).refine((value) => value.tube < value.radius, 'Torus tube radius must be smaller than its major radius.');
const objectSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(80),
  type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus', 'boolean', 'group', 'glb', 'glb_node']),
  position: vec3,
  rotation: vec3,
  scale: vec3.refine((values) => values.every((value) => value > 0 && value <= 1000), 'Scale must be positive.'),
  parentId: z.string().nullable(),
  material,
  geometry: geometry.optional(),
  visible: z.boolean(),
  locked: z.boolean(),
  boolean: z.object({ operation: z.enum(['union', 'subtract', 'intersect']), operandIds: z.tuple([z.string(), z.string()]) }).optional(),
  assetDataUrl: z.string().startsWith('data:model/gltf-binary;base64,').optional(),
  assetRootId: z.string().optional(),
  assetNodeIndex: z.number().int().nonnegative().optional(),
  assetNodeKind: z.enum(['group', 'mesh']).optional(),
});
const sceneSchema = z.object({
  schemaVersion: z.literal(2),
  projectId: z.string().min(1),
  title: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  objects: z.array(objectSchema).max(1000),
  settings: z.object({
    gridSize: z.number().positive(),
    snapEnabled: z.boolean(),
    environment: z.enum(['studio', 'sunset', 'warehouse', 'night']),
    exposure: z.number().min(0.1).max(3),
    backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i),
    shadows: z.boolean(),
  }),
}).superRefine((doc, context) => {
  const ids = new Set(doc.objects.map((object) => object.id));
  if (ids.size !== doc.objects.length) context.addIssue({ code: 'custom', message: 'Object IDs must be unique.' });
  doc.objects.forEach((object, index) => {
    if (object.parentId && !ids.has(object.parentId)) context.addIssue({ code: 'custom', path: ['objects', index, 'parentId'], message: 'Parent object was not found.' });
    if (object.parentId === object.id) context.addIssue({ code: 'custom', path: ['objects', index, 'parentId'], message: 'An object cannot parent itself.' });
    if (object.type === 'glb' && !object.assetDataUrl) context.addIssue({ code: 'custom', path: ['objects', index, 'assetDataUrl'], message: 'Imported models require embedded GLB data.' });
    if (object.type === 'glb_node' && (!object.assetRootId || object.assetNodeIndex === undefined)) context.addIssue({ code: 'custom', path: ['objects', index], message: 'Imported nodes require an asset root and node index.' });
    if (object.type === 'boolean' && (!object.boolean || object.boolean.operandIds.some((id) => !ids.has(id)))) context.addIssue({ code: 'custom', path: ['objects', index, 'boolean'], message: 'Boolean operands were not found.' });
    if (['box', 'sphere', 'cylinder', 'cone', 'torus'].includes(object.type) && !object.geometry) context.addIssue({ code: 'custom', path: ['objects', index, 'geometry'], message: 'Primitives require geometry parameters.' });
  });
  for (const object of doc.objects) {
    const seen = new Set<string>([object.id]);
    let parentId = object.parentId;
    while (parentId) {
      if (seen.has(parentId)) {
        context.addIssue({ code: 'custom', message: `Hierarchy cycle detected at ${object.name}.` });
        break;
      }
      seen.add(parentId);
      parentId = doc.objects.find((item) => item.id === parentId)?.parentId ?? null;
    }
  }
});

const legacyMaterial = z.object({
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  roughness: z.number().min(0).max(1),
  metalness: z.number().min(0).max(1),
  wireframe: z.boolean(),
});
const legacyObject = z.object({
  id: z.string(), name: z.string(),
  type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus', 'group', 'glb']),
  position: vec3, rotation: vec3, scale: vec3, parentId: z.string().nullable(),
  material: legacyMaterial,
  assetDataUrl: z.string().optional(),
});
const legacyScene = z.object({
  schemaVersion: z.literal(1), projectId: z.string(), title: z.string(), revision: z.number().int().nonnegative(), updatedAt: z.string(),
  objects: z.array(legacyObject).max(1000),
  settings: z.object({ gridSize: z.number().positive(), snapEnabled: z.boolean() }),
});

function migrateLegacyScene(value: unknown): SceneDocument {
  const legacy = legacyScene.parse(value);
  return {
    ...legacy,
    schemaVersion: 2,
    objects: legacy.objects.map((object) => ({
      ...object,
      material: { ...DEFAULT_MATERIAL, ...object.material },
      geometry: ['box', 'sphere', 'cylinder', 'cone', 'torus'].includes(object.type) ? { ...DEFAULT_GEOMETRY, ...(object.type === 'cone' ? { radiusTop: 0.02 } : {}) } : undefined,
      visible: true,
      locked: false,
    })),
    settings: {
      ...legacy.settings,
      environment: 'studio',
      exposure: 1,
      backgroundColor: '#20211d',
      shadows: true,
    },
  };
}

export function validateSceneDocument(value: unknown): SceneDocument {
  const candidate = value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 1
    ? migrateLegacyScene(value)
    : value;
  return sceneSchema.parse(candidate) as SceneDocument;
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
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('The file could not be converted to a data URL.'));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

export async function imageFileToDataUrl(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > 6 * 1024 * 1024) throw new Error('Texture images must be 6 MB or smaller.');
  return fileToDataUrl(file);
}
