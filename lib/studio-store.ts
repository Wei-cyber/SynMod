'use client';

import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { create } from 'zustand';

import {
  createId,
  createLampStudy,
  DEFAULT_MATERIAL,
  makeObject,
  PRIMITIVE_LABELS,
  type ActivityEntry,
  type Actor,
  type SceneCommand,
  type SceneDocument,
  type StudioMaterial,
  type StudioObject,
  type ToolMode,
  type Vec3,
} from '@/lib/studio-types';

type WebMcpStatus = 'checking' | 'ready' | 'unavailable' | 'error';
type SaveState = 'saved' | 'saving' | 'error';

interface StudioState {
  doc: SceneDocument;
  selection: string[];
  history: SceneDocument[];
  future: SceneDocument[];
  activity: ActivityEntry[];
  toolMode: ToolMode;
  webmcpStatus: WebMcpStatus;
  saveState: SaveState;
  hydrated: boolean;
  lastAgentChange: { token: number; objectIds: string[] } | null;
  focusRequest: { token: number; objectIds: string[] } | null;
  cameraRequest: { token: number; preset: 'iso' | 'front' | 'top' } | null;
  error: string | null;
  execute: (command: SceneCommand, actor?: Actor) => { objectIds: string[]; label: string };
  select: (objectIds: string[], actor?: Actor) => void;
  focus: (objectIds: string[], actor?: Actor) => void;
  undo: (actor?: Actor) => boolean;
  redo: (actor?: Actor) => boolean;
  hydrate: (doc: SceneDocument | null) => void;
  replaceDocument: (doc: SceneDocument, label?: string) => void;
  setToolMode: (mode: ToolMode) => void;
  setSnapEnabled: (enabled: boolean) => void;
  setCameraPreset: (preset: 'iso' | 'front' | 'top') => void;
  setWebMcpStatus: (status: WebMcpStatus) => void;
  setSaveState: (state: SaveState) => void;
  setError: (error: string | null) => void;
}

function cloneDoc(doc: SceneDocument): SceneDocument {
  return structuredClone(doc);
}

function finiteVec(value: Vec3, label: string, positive = false): Vec3 {
  if (value.length !== 3 || value.some((item) => !Number.isFinite(item))) {
    throw new Error(`${label} must contain three finite numbers.`);
  }
  if (positive && value.some((item) => item <= 0 || item > 1000)) {
    throw new Error(`${label} values must be greater than 0 and no more than 1000.`);
  }
  return [...value] as Vec3;
}

function normalizeMaterial(base: StudioMaterial, patch: Partial<StudioMaterial>): StudioMaterial {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<StudioMaterial>;
  const next = { ...base, ...clean };
  if (!/^#[0-9a-f]{6}$/i.test(next.color)) throw new Error('Color must be a six-digit hex value.');
  if (![next.roughness, next.metalness].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error('Roughness and metalness must be between 0 and 1.');
  }
  return next;
}

function objectById(doc: SceneDocument, id: string) {
  const object = doc.objects.find((item) => item.id === id);
  if (!object) throw new Error(`Object not found: ${id}`);
  return object;
}

function activity(actor: Actor, label: string, objectIds: string[]): ActivityEntry {
  return { id: createId('activity'), actor, label, timestamp: Date.now(), objectIds };
}

function matrixFor(object: StudioObject) {
  const matrix = new Matrix4();
  matrix.compose(
    new Vector3(...object.position),
    new Quaternion().setFromEuler(new Euler(...object.rotation.map(MathUtils.degToRad) as Vec3)),
    new Vector3(...object.scale),
  );
  return matrix;
}

function applyMatrix(object: StudioObject, matrix: Matrix4) {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  const euler = new Euler().setFromQuaternion(quaternion);
  object.position = position.toArray() as Vec3;
  object.rotation = [MathUtils.radToDeg(euler.x), MathUtils.radToDeg(euler.y), MathUtils.radToDeg(euler.z)];
  object.scale = scale.toArray() as Vec3;
}

function defaultOffset(): Vec3 {
  return [0.45, 0.15, 0.45];
}

function perform(doc: SceneDocument, command: SceneCommand) {
  const affected: string[] = [];
  let label = 'Updated scene';

  switch (command.type) {
    case 'add_primitive': {
      const object = makeObject(command.primitiveType, command.name?.trim() || PRIMITIVE_LABELS[command.primitiveType], {
        position: command.position ? finiteVec(command.position, 'Position') : [0, 0.5, 0],
        rotation: command.rotation ? finiteVec(command.rotation, 'Rotation') : [0, 0, 0],
        scale: command.scale ? finiteVec(command.scale, 'Scale', true) : [1, 1, 1],
        material: normalizeMaterial(DEFAULT_MATERIAL, command.material ?? {}),
      });
      doc.objects.push(object);
      affected.push(object.id);
      label = `Added ${object.name}`;
      break;
    }
    case 'import_glb': {
      if (!command.assetDataUrl.startsWith('data:model/gltf-binary;base64,')) throw new Error('Imported GLB data is invalid.');
      const object = makeObject('glb', command.name.trim() || 'Imported model', {
        assetDataUrl: command.assetDataUrl,
        position: [0, 0, 0],
      });
      doc.objects.push(object);
      affected.push(object.id);
      label = `Imported ${object.name}`;
      break;
    }
    case 'set_transform': {
      const object = objectById(doc, command.objectId);
      if (!command.position && !command.rotation && !command.scale) throw new Error('At least one transform value is required.');
      if (command.position) object.position = finiteVec(command.position, 'Position');
      if (command.rotation) object.rotation = finiteVec(command.rotation, 'Rotation');
      if (command.scale) object.scale = finiteVec(command.scale, 'Scale', true);
      affected.push(object.id);
      label = `Transformed ${object.name}`;
      break;
    }
    case 'set_material': {
      const object = objectById(doc, command.objectId);
      if (object.type === 'group' || object.type === 'glb') throw new Error('This object does not expose an editable material.');
      object.material = normalizeMaterial(object.material, command.material);
      affected.push(object.id);
      label = `Updated ${object.name} material`;
      break;
    }
    case 'rename': {
      const object = objectById(doc, command.objectId);
      const name = command.name.trim().slice(0, 80);
      if (!name) throw new Error('Name cannot be empty.');
      object.name = name;
      affected.push(object.id);
      label = `Renamed object to ${name}`;
      break;
    }
    case 'duplicate': {
      const source = objectById(doc, command.objectId);
      const subtree = new Set<string>();
      const visit = (id: string) => {
        subtree.add(id);
        doc.objects.filter((item) => item.parentId === id).forEach((child) => visit(child.id));
      };
      visit(source.id);
      const idMap = new Map<string, string>();
      subtree.forEach((id) => idMap.set(id, createId()));
      const offset = command.offset ? finiteVec(command.offset, 'Offset') : defaultOffset();
      const clones = doc.objects.filter((item) => subtree.has(item.id)).map((item) => {
        const copy = structuredClone(item);
        copy.id = idMap.get(item.id)!;
        copy.parentId = item.parentId && subtree.has(item.parentId) ? idMap.get(item.parentId)! : item.parentId;
        if (item.id === source.id) {
          copy.name = command.name?.trim() || `${item.name} copy`;
          copy.position = item.position.map((value, index) => value + offset[index]) as Vec3;
        }
        return copy;
      });
      doc.objects.push(...clones);
      affected.push(idMap.get(source.id)!);
      label = `Duplicated ${source.name}`;
      break;
    }
    case 'delete': {
      const source = objectById(doc, command.objectId);
      const remove = new Set([source.id]);
      let changed = true;
      while (changed) {
        changed = false;
        doc.objects.forEach((item) => {
          if (item.parentId && remove.has(item.parentId) && !remove.has(item.id)) {
            remove.add(item.id);
            changed = true;
          }
        });
      }
      doc.objects = doc.objects.filter((item) => !remove.has(item.id));
      affected.push(...remove);
      label = `Deleted ${source.name}`;
      break;
    }
    case 'group': {
      const ids = [...new Set(command.objectIds)];
      if (ids.length < 2) throw new Error('Choose at least two objects to group.');
      const objects = ids.map((id) => objectById(doc, id));
      const parentId = objects[0].parentId;
      if (objects.some((item) => item.parentId !== parentId)) throw new Error('Objects must share the same parent to be grouped.');
      const center = objects.reduce<Vec3>((sum, item) => [sum[0] + item.position[0], sum[1] + item.position[1], sum[2] + item.position[2]], [0, 0, 0]).map((value) => value / objects.length) as Vec3;
      const group = makeObject('group', command.name?.trim() || 'Group', { position: center, parentId });
      doc.objects.push(group);
      objects.forEach((item) => {
        item.parentId = group.id;
        item.position = item.position.map((value, index) => value - center[index]) as Vec3;
      });
      affected.push(group.id, ...ids);
      label = `Grouped ${objects.length} objects`;
      break;
    }
    case 'ungroup': {
      const group = objectById(doc, command.groupId);
      if (group.type !== 'group') throw new Error('Only group objects can be ungrouped.');
      const groupMatrix = matrixFor(group);
      const children = doc.objects.filter((item) => item.parentId === group.id);
      children.forEach((child) => {
        applyMatrix(child, groupMatrix.clone().multiply(matrixFor(child)));
        child.parentId = group.parentId;
      });
      doc.objects = doc.objects.filter((item) => item.id !== group.id);
      affected.push(...children.map((item) => item.id), group.id);
      label = `Ungrouped ${group.name}`;
      break;
    }
  }

  doc.revision += 1;
  doc.updatedAt = new Date().toISOString();
  return { objectIds: affected, label };
}

export const useStudioStore = create<StudioState>((set, get) => ({
  doc: createLampStudy(),
  selection: ['lamp-shade'],
  history: [],
  future: [],
  activity: [
    { id: 'welcome-agent', actor: 'agent', label: 'Scene tools are ready', timestamp: Date.now() - 8_000, objectIds: [] },
    { id: 'welcome-human', actor: 'human', label: 'Opened Lamp Study', timestamp: Date.now() - 65_000, objectIds: [] },
  ],
  toolMode: 'translate',
  webmcpStatus: 'checking',
  saveState: 'saved',
  hydrated: false,
  lastAgentChange: null,
  focusRequest: null,
  cameraRequest: null,
  error: null,
  execute(command, actor = 'human') {
    const current = get();
    const before = cloneDoc(current.doc);
    const next = cloneDoc(current.doc);
    const result = perform(next, command);
    set({
      doc: next,
      history: [...current.history, before].slice(-100),
      future: [],
      selection: result.objectIds.filter((id) => next.objects.some((object) => object.id === id)).slice(0, 1),
      activity: [activity(actor, result.label, result.objectIds), ...current.activity].slice(0, 60),
      lastAgentChange: actor === 'agent' ? { token: Date.now(), objectIds: result.objectIds } : current.lastAgentChange,
      saveState: 'saving',
      error: null,
    });
    return result;
  },
  select(objectIds, actor = 'human') {
    const valid = [...new Set(objectIds)].filter((id) => get().doc.objects.some((object) => object.id === id));
    set((state) => ({
      selection: valid,
      activity: actor === 'agent' ? [activity(actor, `Selected ${valid.length || 'no'} object${valid.length === 1 ? '' : 's'}`, valid), ...state.activity].slice(0, 60) : state.activity,
    }));
  },
  focus(objectIds, actor = 'human') {
    const valid = objectIds.filter((id) => get().doc.objects.some((object) => object.id === id));
    if (!valid.length) throw new Error('No valid objects to focus.');
    set((state) => ({
      focusRequest: { token: Date.now(), objectIds: valid },
      activity: actor === 'agent' ? [activity(actor, 'Focused the viewport', valid), ...state.activity].slice(0, 60) : state.activity,
    }));
  },
  undo(actor = 'human') {
    const state = get();
    const previous = state.history.at(-1);
    if (!previous) return false;
    const restored = cloneDoc(previous);
    restored.revision = state.doc.revision + 1;
    restored.updatedAt = new Date().toISOString();
    set({
      doc: restored,
      history: state.history.slice(0, -1),
      future: [cloneDoc(state.doc), ...state.future].slice(0, 100),
      selection: state.selection.filter((id) => restored.objects.some((item) => item.id === id)),
      activity: [activity(actor, 'Undid scene change', []), ...state.activity].slice(0, 60),
      saveState: 'saving',
    });
    return true;
  },
  redo(actor = 'human') {
    const state = get();
    const next = state.future[0];
    if (!next) return false;
    const restored = cloneDoc(next);
    restored.revision = state.doc.revision + 1;
    restored.updatedAt = new Date().toISOString();
    set({
      doc: restored,
      history: [...state.history, cloneDoc(state.doc)].slice(-100),
      future: state.future.slice(1),
      selection: state.selection.filter((id) => restored.objects.some((item) => item.id === id)),
      activity: [activity(actor, 'Redid scene change', []), ...state.activity].slice(0, 60),
      saveState: 'saving',
    });
    return true;
  },
  hydrate(doc) {
    set({ doc: doc ?? createLampStudy(), history: [], future: [], hydrated: true, saveState: 'saved' });
  },
  replaceDocument(doc, label = 'Imported project') {
    const state = get();
    set({
      doc,
      selection: [],
      history: [...state.history, cloneDoc(state.doc)].slice(-100),
      future: [],
      activity: [activity('human', label, doc.objects.map((item) => item.id)), ...state.activity].slice(0, 60),
      saveState: 'saving',
    });
  },
  setToolMode(toolMode) { set({ toolMode }); },
  setSnapEnabled(enabled) {
    const state = get();
    set({ doc: { ...state.doc, settings: { ...state.doc.settings, snapEnabled: enabled } }, saveState: 'saving' });
  },
  setCameraPreset(preset) { set({ cameraRequest: { token: Date.now(), preset } }); },
  setWebMcpStatus(webmcpStatus) { set({ webmcpStatus }); },
  setSaveState(saveState) { set({ saveState }); },
  setError(error) { set({ error }); },
}));

export function getObjectSnapshot(objectId: string) {
  const object = useStudioStore.getState().doc.objects.find((item) => item.id === objectId);
  return object ? structuredClone(object) : null;
}
