import { z } from 'zod';

import { DEFAULT_GEOMETRY, DEFAULT_MATERIAL, type FeatureRecord, type SceneDocument } from '@/lib/studio-types';

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
  width: z.number().positive().max(1000), height: z.number().positive().max(1000), depth: z.number().positive().max(1000),
  radius: z.number().positive().max(1000), radiusTop: z.number().positive().max(1000), radiusBottom: z.number().positive().max(1000), tube: z.number().positive().max(1000),
  radialSegments: z.number().int().min(3).max(256), heightSegments: z.number().int().min(1).max(128),
}).refine((value) => value.tube < value.radius, 'Torus tube radius must be smaller than its major radius.');
const objectSchema = z.object({
  id: z.string().min(1).max(160), name: z.string().min(1).max(80),
  type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus', 'boolean', 'group', 'glb', 'glb_node']),
  position: vec3, rotation: vec3,
  scale: vec3.refine((values) => values.every((value) => value > 0 && value <= 1000), 'Scale must be positive.'),
  parentId: z.string().nullable(), material, geometry: geometry.optional(), visible: z.boolean(), locked: z.boolean(),
  boolean: z.object({ operation: z.enum(['union', 'subtract', 'intersect']), operandIds: z.tuple([z.string(), z.string()]) }).optional(),
  assetDataUrl: z.string().startsWith('data:model/gltf-binary;base64,').optional(), assetRootId: z.string().optional(),
  assetNodeIndex: z.number().int().nonnegative().optional(), assetNodeKind: z.enum(['group', 'mesh']).optional(),
  triangleCount: z.number().int().nonnegative().optional(), topologyStatus: z.enum(['manifold', 'non_manifold', 'unknown']).optional(),
  nonManifoldEdgeCount: z.number().int().nonnegative().optional(), missingMaterial: z.boolean().optional(),
});
const settingsSchema = z.object({
  gridSize: z.number().positive(), snapEnabled: z.boolean(),
  environment: z.enum(['studio', 'sunset', 'warehouse', 'night']), exposure: z.number().min(0.1).max(3),
  backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i), shadows: z.boolean(),
});
const featureSchema = z.object({
  id: z.string().min(1).max(160), kind: z.enum(['source', 'transform', 'geometry', 'material', 'boolean', 'hierarchy', 'visibility', 'environment', 'version']),
  label: z.string().min(1).max(160), objectIds: z.array(z.string().min(1)).max(1000), revision: z.number().int().nonnegative(),
  createdAt: z.string(), actor: z.enum(['human', 'agent']),
});
const snapshotSchema = z.object({
  title: z.string().min(1).max(100), revision: z.number().int().nonnegative(), objects: z.array(objectSchema).max(1000),
  settings: settingsSchema, features: z.array(featureSchema).max(5000),
});
const checkpointSchema = z.object({
  id: z.string().min(1).max(160), name: z.string().min(1).max(80), createdAt: z.string(), sourceRevision: z.number().int().nonnegative(), snapshot: snapshotSchema,
});

function validateObjectGraph(objects: z.infer<typeof objectSchema>[], context: z.RefinementCtx, prefix: (string | number)[] = ['objects']) {
  const ids = new Set(objects.map((object) => object.id));
  if (ids.size !== objects.length) context.addIssue({ code: 'custom', path: prefix, message: 'Object IDs must be unique.' });
  objects.forEach((object, index) => {
    const path = [...prefix, index];
    if (object.parentId && !ids.has(object.parentId)) context.addIssue({ code: 'custom', path: [...path, 'parentId'], message: 'Parent object was not found.' });
    if (object.parentId === object.id) context.addIssue({ code: 'custom', path: [...path, 'parentId'], message: 'An object cannot parent itself.' });
    if (object.type === 'glb' && !object.assetDataUrl) context.addIssue({ code: 'custom', path: [...path, 'assetDataUrl'], message: 'Imported models require embedded GLB data.' });
    if (object.type === 'glb_node' && (!object.assetRootId || object.assetNodeIndex === undefined)) context.addIssue({ code: 'custom', path, message: 'Imported nodes require an asset root and node index.' });
    if (object.type === 'boolean' && (!object.boolean || object.boolean.operandIds.some((id) => !ids.has(id)))) context.addIssue({ code: 'custom', path: [...path, 'boolean'], message: 'Boolean operands were not found.' });
    if (['box', 'sphere', 'cylinder', 'cone', 'torus'].includes(object.type) && !object.geometry) context.addIssue({ code: 'custom', path: [...path, 'geometry'], message: 'Primitives require geometry parameters.' });
  });
  for (const object of objects) {
    const seen = new Set<string>([object.id]);
    let parentId = object.parentId;
    while (parentId) {
      if (seen.has(parentId)) {
        context.addIssue({ code: 'custom', path: prefix, message: `Hierarchy cycle detected at ${object.name}.` });
        break;
      }
      seen.add(parentId);
      parentId = objects.find((item) => item.id === parentId)?.parentId ?? null;
    }
  }
}

const sceneSchema = z.object({
  schemaVersion: z.literal(3), projectId: z.string().min(1).max(160), title: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(), updatedAt: z.string(), objects: z.array(objectSchema).max(1000),
  features: z.array(featureSchema).max(5000), checkpoints: z.array(checkpointSchema).max(100),
  branch: z.object({ parentProjectId: z.string().min(1), checkpointId: z.string().min(1).optional() }).optional(), settings: settingsSchema,
}).superRefine((doc, context) => {
  validateObjectGraph(doc.objects, context);
  const checkpointIds = new Set(doc.checkpoints.map((checkpoint) => checkpoint.id));
  if (checkpointIds.size !== doc.checkpoints.length) context.addIssue({ code: 'custom', path: ['checkpoints'], message: 'Checkpoint IDs must be unique.' });
  doc.checkpoints.forEach((checkpoint, index) => validateObjectGraph(checkpoint.snapshot.objects, context, ['checkpoints', index, 'snapshot', 'objects']));
});

const legacyMaterial = z.object({ color: z.string().regex(/^#[0-9a-f]{6}$/i), roughness: z.number().min(0).max(1), metalness: z.number().min(0).max(1), wireframe: z.boolean() });
const legacyObject = z.object({
  id: z.string(), name: z.string(), type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus', 'group', 'glb']),
  position: vec3, rotation: vec3, scale: vec3, parentId: z.string().nullable(), material: legacyMaterial, assetDataUrl: z.string().optional(),
});
const legacyScene = z.object({
  schemaVersion: z.literal(1), projectId: z.string(), title: z.string(), revision: z.number().int().nonnegative(), updatedAt: z.string(),
  objects: z.array(legacyObject).max(1000), settings: z.object({ gridSize: z.number().positive(), snapEnabled: z.boolean() }),
});
const versionTwoScene = z.object({
  schemaVersion: z.literal(2), projectId: z.string(), title: z.string(), revision: z.number().int().nonnegative(), updatedAt: z.string(),
  objects: z.array(objectSchema).max(1000), settings: settingsSchema,
});

function initialFeature(objects: Array<{ id: string }>, revision: number, createdAt: string): FeatureRecord[] {
  return [{ id: `feature-migrated-${revision}`, kind: 'source', label: 'Imported existing project history', objectIds: objects.map((object) => object.id), revision, createdAt, actor: 'human' }];
}

function migrateVersionTwo(value: unknown): SceneDocument {
  const scene = versionTwoScene.parse(value);
  return { ...scene, schemaVersion: 3, features: initialFeature(scene.objects, scene.revision, scene.updatedAt), checkpoints: [] };
}

function migrateLegacyScene(value: unknown): SceneDocument {
  const legacy = legacyScene.parse(value);
  return migrateVersionTwo({
    ...legacy, schemaVersion: 2,
    objects: legacy.objects.map((object) => ({
      ...object, material: { ...DEFAULT_MATERIAL, ...object.material },
      geometry: ['box', 'sphere', 'cylinder', 'cone', 'torus'].includes(object.type) ? { ...DEFAULT_GEOMETRY, ...(object.type === 'cone' ? { radiusTop: 0.02 } : {}) } : undefined,
      visible: true, locked: false,
    })),
    settings: { ...legacy.settings, environment: 'studio', exposure: 1, backgroundColor: '#20211d', shadows: true },
  });
}

export function validateSceneDocument(value: unknown): SceneDocument {
  let candidate = value;
  if (candidate && typeof candidate === 'object' && 'schemaVersion' in candidate) {
    if (candidate.schemaVersion === 1) candidate = migrateLegacyScene(candidate);
    else if (candidate.schemaVersion === 2) candidate = migrateVersionTwo(candidate);
  }
  return sceneSchema.parse(candidate) as SceneDocument;
}

export interface LocalProjectSummary {
  projectId: string;
  title: string;
  revision: number;
  updatedAt: string;
  objectCount: number;
  checkpointCount: number;
}

const DB_NAME = 'model-room';
const STORE_NAME = 'projects';
const LEGACY_KEY = 'current-scene';
const CURRENT_PROJECT_KEY = 'current-project-id';
const PROJECT_PREFIX = 'project:';

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
  });
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadLocalProject(projectId: string): Promise<SceneDocument | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openDatabase();
  try {
    const value = await requestValue(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(`${PROJECT_PREFIX}${projectId}`));
    return value ? validateSceneDocument(value) : null;
  } finally { database.close(); }
}

export async function loadLocalScene(): Promise<SceneDocument | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openDatabase();
  try {
    const read = (key: IDBValidKey) => requestValue(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(key));
    const projectId = await read(CURRENT_PROJECT_KEY);
    let value: unknown;
    if (typeof projectId === 'string') value = await read(`${PROJECT_PREFIX}${projectId}`);
    if (!value) value = await read(LEGACY_KEY);
    return value ? validateSceneDocument(value) : null;
  } finally { database.close(); }
}

export async function listLocalProjects(): Promise<LocalProjectSummary[]> {
  if (typeof indexedDB === 'undefined') return [];
  const database = await openDatabase();
  try {
    const keys = await requestValue(database.transaction(STORE_NAME).objectStore(STORE_NAME).getAllKeys());
    const values = await Promise.all(keys.filter((key): key is string => typeof key === 'string' && key.startsWith(PROJECT_PREFIX)).map((key) => requestValue(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(key))));
    return values.flatMap((value) => {
      try {
        const doc = validateSceneDocument(value);
        return [{ projectId: doc.projectId, title: doc.title, revision: doc.revision, updatedAt: doc.updatedAt, objectCount: doc.objects.length, checkpointCount: doc.checkpoints.length }];
      } catch { return []; }
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } finally { database.close(); }
}

export async function saveLocalScene(doc: SceneDocument) {
  if (typeof indexedDB === 'undefined') return;
  const validated = validateSceneDocument(doc);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(validated, `${PROJECT_PREFIX}${validated.projectId}`);
      store.put(validated.projectId, CURRENT_PROJECT_KEY);
      store.put(validated, LEGACY_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Local save was cancelled.'));
    });
  } finally { database.close(); }
}

export function downloadJson(doc: SceneDocument) {
  const blob = new Blob([JSON.stringify(validateSceneDocument(doc), null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${safeFilename(doc.title)}.model-room.json`);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function safeFilename(value: string) {
  return value.trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'model-room-project';
}

export async function readJsonProject(file: File) {
  if (file.size > 35 * 1024 * 1024) throw new Error('Project files must be 35 MB or smaller.');
  return validateSceneDocument(JSON.parse(await file.text()) as unknown);
}

export function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The file could not be converted to a data URL.'));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

export async function imageFileToDataUrl(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > 6 * 1024 * 1024) throw new Error('Texture images must be 6 MB or smaller.');
  return fileToDataUrl(file);
}
