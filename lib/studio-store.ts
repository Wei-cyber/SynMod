'use client';

import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { create } from 'zustand';

import { analyzeScene, compareCheckpoint } from '@/lib/scene-analysis';
import { makeEditableCopy } from '@/lib/share-links';
import {
  createId,
  createRoverStudy,
  DEFAULT_GEOMETRY,
  DEFAULT_MATERIAL,
  isPrimitiveType,
  makeObject,
  PRIMITIVE_LABELS,
  type ActivityEntry,
  type AgentTaskState,
  type Actor,
  type FeatureKind,
  type PrimitiveGeometry,
  type SceneCommand,
  type SceneDocument,
  type SceneSnapshot,
  type StudioMaterial,
  type StudioObject,
  type ToolMode,
  type Vec3,
} from '@/lib/studio-types';

type WebMcpStatus = 'checking' | 'ready' | 'unavailable' | 'error';
type SaveState = 'saved' | 'saving' | 'error';

export interface TransactionPreview {
  revision: number;
  summary: string;
  labels: string[];
  affectedObjectIds: string[];
  objects: StudioObject[];
}

interface StudioState {
  doc: SceneDocument;
  selection: string[];
  history: SceneDocument[];
  future: SceneDocument[];
  activity: ActivityEntry[];
  agentTask: AgentTaskState;
  agentTaskAbort: AbortController | null;
  toolMode: ToolMode;
  webmcpStatus: WebMcpStatus;
  saveState: SaveState;
  hydrated: boolean;
  lastAgentChange: { token: number; objectIds: string[] } | null;
  focusRequest: { token: number; objectIds: string[] } | null;
  cameraRequest: { token: number; preset: 'iso' | 'front' | 'top' } | null;
  error: string | null;
  readOnly: boolean;
  execute: (command: SceneCommand, actor?: Actor) => { objectIds: string[]; label: string };
  previewTransaction: (commands: SceneCommand[]) => TransactionPreview;
  executeTransaction: (commands: SceneCommand[], actor?: Actor, label?: string, options?: { preserveSelection?: boolean }) => { objectIds: string[]; label: string };
  select: (objectIds: string[], actor?: Actor) => void;
  focus: (objectIds: string[], actor?: Actor) => void;
  undo: (actor?: Actor) => boolean;
  redo: (actor?: Actor) => boolean;
  hydrate: (doc: SceneDocument | null, readOnly?: boolean) => void;
  replaceDocument: (doc: SceneDocument, label?: string, readOnly?: boolean) => void;
  openDocument: (doc: SceneDocument, label?: string) => void;
  createEditableCopy: (title?: string) => SceneDocument;
  setToolMode: (mode: ToolMode) => void;
  setSnapEnabled: (enabled: boolean) => void;
  setCameraPreset: (preset: 'iso' | 'front' | 'top') => void;
  setWebMcpStatus: (status: WebMcpStatus) => void;
  setSaveState: (state: SaveState) => void;
  setError: (error: string | null) => void;
  startAgentTask: (task: AgentTaskState, controller: AbortController) => void;
  finishAgentTask: (token: string, status: AgentTaskState['status'], durationMs: number, objectIds?: string[], error?: string) => void;
  cancelAgentTask: () => void;
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

function normalizeGeometry(base: PrimitiveGeometry, patch: Partial<PrimitiveGeometry>): PrimitiveGeometry {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<PrimitiveGeometry>;
  const next = { ...base, ...clean };
  const dimensions = [next.width, next.height, next.depth, next.radius, next.radiusTop, next.radiusBottom, next.tube];
  if (dimensions.some((value) => !Number.isFinite(value) || value <= 0 || value > 1000)) {
    throw new Error('Geometry dimensions must be finite, greater than 0, and no more than 1000.');
  }
  if (!Number.isInteger(next.radialSegments) || next.radialSegments < 3 || next.radialSegments > 256) {
    throw new Error('Radial segments must be an integer from 3 to 256.');
  }
  if (!Number.isInteger(next.heightSegments) || next.heightSegments < 1 || next.heightSegments > 128) {
    throw new Error('Height segments must be an integer from 1 to 128.');
  }
  if (next.tube >= next.radius) throw new Error('Torus tube radius must be smaller than its major radius.');
  return next;
}

function validateTexture(value: string | undefined, label: string) {
  if (value === undefined) return;
  if (!value.startsWith('data:image/')) throw new Error(`${label} must be an embedded image.`);
  if (value.length > 8_000_000) throw new Error(`${label} is too large. Use an image under 6 MB.`);
}

function normalizeMaterial(base: StudioMaterial, patch: Partial<StudioMaterial>): StudioMaterial {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<StudioMaterial>;
  const next = { ...base, ...clean };
  if (!/^#[0-9a-f]{6}$/i.test(next.color) || !/^#[0-9a-f]{6}$/i.test(next.emissive)) {
    throw new Error('Material colors must be six-digit hex values.');
  }
  if (![next.roughness, next.metalness, next.opacity, next.emissiveIntensity].every((value) => Number.isFinite(value))) {
    throw new Error('Material values must be finite.');
  }
  if (next.roughness < 0 || next.roughness > 1 || next.metalness < 0 || next.metalness > 1 || next.opacity < 0 || next.opacity > 1 || next.emissiveIntensity < 0 || next.emissiveIntensity > 10) {
    throw new Error('Material values are outside their supported range.');
  }
  validateTexture(next.baseColorTexture, 'Base color texture');
  validateTexture(next.normalTexture, 'Normal texture');
  validateTexture(next.roughnessTexture, 'Roughness texture');
  validateTexture(next.metalnessTexture, 'Metalness texture');
  return next;
}

function objectById(doc: SceneDocument, id: string) {
  const object = doc.objects.find((item) => item.id === id);
  if (!object) throw new Error(`Object not found: ${id}`);
  return object;
}

function activity(actor: Actor, label: string, objectIds: string[], durationMs?: number): ActivityEntry {
  return { id: createId('activity'), actor, label, timestamp: Date.now(), objectIds, durationMs };
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

function snapshotFromDoc(doc: SceneDocument): SceneSnapshot {
  return {
    title: doc.title,
    revision: doc.revision,
    objects: structuredClone(doc.objects),
    settings: structuredClone(doc.settings),
    features: structuredClone(doc.features),
  };
}

function commandFeatureKind(command: SceneCommand): FeatureKind {
  switch (command.type) {
    case 'add_primitive':
    case 'import_glb': return 'source';
    case 'set_transform': return 'transform';
    case 'set_geometry': return 'geometry';
    case 'set_material': return 'material';
    case 'boolean': return 'boolean';
    case 'group':
    case 'ungroup':
    case 'duplicate':
    case 'delete':
    case 'rename': return 'hierarchy';
    case 'set_visibility': return 'visibility';
    case 'set_snap':
    case 'set_environment': return 'environment';
    case 'create_checkpoint':
    case 'restore_checkpoint':
    case 'branch_project':
    case 'duplicate_project': return 'version';
  }
}

function recordFeature(doc: SceneDocument, command: SceneCommand, label: string, objectIds: string[], actor: Actor) {
  doc.features.push({
    id: createId('feature'),
    kind: commandFeatureKind(command),
    label,
    objectIds: [...objectIds],
    revision: doc.revision,
    createdAt: doc.updatedAt,
    actor,
  });
  doc.features = doc.features.slice(-5000);
}

export function applySceneCommand(doc: SceneDocument, command: SceneCommand) {
  const affected: string[] = [];
  let label = 'Updated scene';

  switch (command.type) {
    case 'add_primitive': {
      const object = makeObject(command.primitiveType, command.name?.trim() || PRIMITIVE_LABELS[command.primitiveType], {
        ...(command.objectId ? { id: command.objectId } : {}),
        position: command.position ? finiteVec(command.position, 'Position') : [0, 0.5, 0],
        rotation: command.rotation ? finiteVec(command.rotation, 'Rotation') : [0, 0, 0],
        scale: command.scale ? finiteVec(command.scale, 'Scale', true) : [1, 1, 1],
        geometry: normalizeGeometry({ ...DEFAULT_GEOMETRY, ...(command.primitiveType === 'cone' ? { radiusTop: 0.02 } : {}) }, command.geometry ?? {}),
        material: normalizeMaterial(DEFAULT_MATERIAL, command.material ?? {}),
      });
      doc.objects.push(object);
      affected.push(object.id);
      label = `Added ${object.name}`;
      break;
    }
    case 'import_glb': {
      if (!command.assetDataUrl.startsWith('data:model/gltf-binary;base64,')) throw new Error('Imported GLB data is invalid.');
      const root = makeObject('glb', command.name.trim() || 'Imported model', {
        assetDataUrl: command.assetDataUrl,
        position: [0, 0, 0],
      });
      doc.objects.push(root);
      const nodeIdByIndex = new Map<number, string>();
      for (const descriptor of command.nodes ?? []) {
        const id = createId('asset-node');
        nodeIdByIndex.set(descriptor.nodeIndex, id);
        const node = makeObject('glb_node', descriptor.name, {
          id,
          parentId: descriptor.parentNodeIndex === null ? root.id : nodeIdByIndex.get(descriptor.parentNodeIndex) ?? root.id,
          position: finiteVec(descriptor.position, 'Imported node position'),
          rotation: finiteVec(descriptor.rotation, 'Imported node rotation'),
          scale: finiteVec(descriptor.scale, 'Imported node scale', true),
          material: normalizeMaterial(DEFAULT_MATERIAL, descriptor.material ?? {}),
          visible: descriptor.visible,
          assetRootId: root.id,
          assetNodeIndex: descriptor.nodeIndex,
          assetNodeKind: descriptor.kind,
          triangleCount: descriptor.triangleCount,
          topologyStatus: descriptor.topologyStatus,
          nonManifoldEdgeCount: descriptor.nonManifoldEdgeCount,
          missingMaterial: descriptor.missingMaterial,
        });
        doc.objects.push(node);
      }
      affected.push(root.id, ...nodeIdByIndex.values());
      label = `Imported ${root.name} with ${nodeIdByIndex.size} editable node${nodeIdByIndex.size === 1 ? '' : 's'}`;
      break;
    }
    case 'set_transform': {
      const object = objectById(doc, command.objectId);
      if (object.locked) throw new Error(`${object.name} is locked.`);
      if (!command.position && !command.rotation && !command.scale) throw new Error('At least one transform value is required.');
      if (command.position) object.position = finiteVec(command.position, 'Position');
      if (command.rotation) object.rotation = finiteVec(command.rotation, 'Rotation');
      if (command.scale) object.scale = finiteVec(command.scale, 'Scale', true);
      affected.push(object.id);
      label = `Transformed ${object.name}`;
      break;
    }
    case 'set_geometry': {
      const object = objectById(doc, command.objectId);
      if (!isPrimitiveType(object.type) || !object.geometry) throw new Error('Only primitives expose editable geometry parameters.');
      if (!Object.values(command.geometry).some((value) => value !== undefined)) throw new Error('Provide at least one geometry parameter.');
      object.geometry = normalizeGeometry(object.geometry, command.geometry);
      affected.push(object.id);
      label = `Refined ${object.name} geometry`;
      break;
    }
    case 'set_material': {
      const object = objectById(doc, command.objectId);
      if (object.type === 'group' || object.type === 'glb') throw new Error('This object does not expose an editable material.');
      if (!Object.values(command.material).some((value) => value !== undefined)) throw new Error('Provide at least one material property.');
      object.material = normalizeMaterial(object.material, command.material);
      affected.push(object.id);
      label = `Updated ${object.name} material`;
      break;
    }
    case 'set_visibility': {
      const object = objectById(doc, command.objectId);
      object.visible = command.visible;
      affected.push(object.id);
      label = `${command.visible ? 'Showed' : 'Hid'} ${object.name}`;
      break;
    }
    case 'set_snap': {
      doc.settings.snapEnabled = command.enabled;
      label = `${command.enabled ? 'Enabled' : 'Disabled'} transform snapping`;
      break;
    }
    case 'set_environment': {
      if (command.environment === undefined && command.exposure === undefined && command.backgroundColor === undefined && command.shadows === undefined) throw new Error('Provide at least one environment property.');
      if (command.environment) doc.settings.environment = command.environment;
      if (command.exposure !== undefined) {
        if (!Number.isFinite(command.exposure) || command.exposure < 0.1 || command.exposure > 3) throw new Error('Exposure must be between 0.1 and 3.');
        doc.settings.exposure = command.exposure;
      }
      if (command.backgroundColor !== undefined) {
        if (!/^#[0-9a-f]{6}$/i.test(command.backgroundColor)) throw new Error('Background color must be a six-digit hex value.');
        doc.settings.backgroundColor = command.backgroundColor;
      }
      if (command.shadows !== undefined) doc.settings.shadows = command.shadows;
      label = 'Updated scene environment';
      break;
    }
    case 'boolean': {
      const [leftId, rightId] = command.operandIds;
      if (leftId === rightId) throw new Error('Boolean operands must be different objects.');
      const left = objectById(doc, leftId);
      const right = objectById(doc, rightId);
      if (![left, right].every((item) => isPrimitiveType(item.type) || item.type === 'boolean')) {
        throw new Error('Boolean operations currently support primitives and Boolean results.');
      }
      if (left.parentId !== right.parentId) throw new Error('Boolean operands must share the same parent.');
      const result = makeObject('boolean', command.name?.trim() || `${left.name} ${command.operation}`, {
        ...(command.resultId ? { id: command.resultId } : {}),
        position: [0, 0, 0],
        parentId: left.parentId,
        material: left.material,
        boolean: { operation: command.operation, operandIds: [left.id, right.id] },
      });
      left.visible = false;
      right.visible = false;
      doc.objects.push(result);
      affected.push(result.id, left.id, right.id);
      label = `Created ${command.operation} result from ${left.name} and ${right.name}`;
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
      subtree.forEach((id) => idMap.set(id, id === source.id && command.resultId ? command.resultId : createId()));
      const offset = command.offset ? finiteVec(command.offset, 'Offset') : defaultOffset();
      const clones = doc.objects.filter((item) => subtree.has(item.id)).map((item) => {
        const copy = structuredClone(item);
        copy.id = idMap.get(item.id)!;
        copy.parentId = item.parentId && subtree.has(item.parentId) ? idMap.get(item.parentId)! : item.parentId;
        if (copy.assetRootId && idMap.has(copy.assetRootId)) copy.assetRootId = idMap.get(copy.assetRootId)!;
        if (copy.boolean) copy.boolean.operandIds = copy.boolean.operandIds.map((id) => idMap.get(id) ?? id) as [string, string];
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
      if (source.boolean) {
        source.boolean.operandIds.forEach((id) => {
          const operand = doc.objects.find((item) => item.id === id);
          if (operand) operand.visible = true;
        });
      }
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
      const group = makeObject('group', command.name?.trim() || 'Group', { ...(command.resultId ? { id: command.resultId } : {}), position: center, parentId });
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
    case 'create_checkpoint': {
      const name = command.name.trim().slice(0, 80);
      if (!name) throw new Error('Checkpoint name cannot be empty.');
      const checkpoint = {
        id: createId('checkpoint'),
        name,
        createdAt: new Date().toISOString(),
        sourceRevision: doc.revision,
        snapshot: snapshotFromDoc(doc),
      };
      doc.checkpoints.push(checkpoint);
      doc.checkpoints = doc.checkpoints.slice(-100);
      affected.push(...doc.objects.map((object) => object.id));
      label = `Created checkpoint “${name}”`;
      break;
    }
    case 'restore_checkpoint': {
      const checkpoint = doc.checkpoints.find((item) => item.id === command.checkpointId);
      if (!checkpoint) throw new Error(`Checkpoint not found: ${command.checkpointId}`);
      doc.objects = structuredClone(checkpoint.snapshot.objects);
      doc.settings = structuredClone(checkpoint.snapshot.settings);
      doc.features = structuredClone(checkpoint.snapshot.features);
      affected.push(...doc.objects.map((object) => object.id));
      label = `Restored checkpoint “${checkpoint.name}”`;
      break;
    }
    case 'branch_project': {
      const parentProjectId = doc.projectId;
      const checkpoint = command.checkpointId ? doc.checkpoints.find((item) => item.id === command.checkpointId) : undefined;
      if (command.checkpointId && !checkpoint) throw new Error(`Checkpoint not found: ${command.checkpointId}`);
      if (checkpoint) {
        doc.objects = structuredClone(checkpoint.snapshot.objects);
        doc.settings = structuredClone(checkpoint.snapshot.settings);
        doc.features = structuredClone(checkpoint.snapshot.features);
      }
      const fallbackTitle = `${checkpoint?.snapshot.title ?? doc.title} branch`;
      doc.projectId = createId('project');
      doc.title = command.name?.trim().slice(0, 100) || fallbackTitle;
      doc.branch = { parentProjectId, ...(checkpoint ? { checkpointId: checkpoint.id } : {}) };
      affected.push(...doc.objects.map((object) => object.id));
      label = `Branched project as “${doc.title}”`;
      break;
    }
    case 'duplicate_project': {
      const parentProjectId = doc.projectId;
      doc.projectId = createId('project');
      doc.title = command.name?.trim().slice(0, 100) || `${doc.title} copy`;
      doc.branch = { parentProjectId };
      affected.push(...doc.objects.map((object) => object.id));
      label = `Duplicated project as “${doc.title}”`;
      break;
    }
  }

  return { objectIds: affected, label };
}

function finishMutation(doc: SceneDocument, revision: number) {
  doc.revision = revision + 1;
  doc.updatedAt = new Date().toISOString();
}

function unique(values: string[]) {
  return [...new Set(values)];
}

export const useStudioStore = create<StudioState>((set, get) => ({
  doc: createRoverStudy(),
  selection: ['rover-chassis'],
  history: [],
  future: [],
  activity: [
    { id: 'welcome-agent', actor: 'agent', label: 'Scene tools are ready', timestamp: Date.now() - 8_000, objectIds: [] },
    { id: 'welcome-human', actor: 'human', label: 'Opened Rover Study', timestamp: Date.now() - 65_000, objectIds: [] },
  ],
  agentTask: { token: 'idle', title: 'Agent ready', status: 'idle', startedAt: 0, affectedObjectIds: [] },
  agentTaskAbort: null,
  toolMode: 'translate',
  webmcpStatus: 'checking',
  saveState: 'saved',
  hydrated: false,
  lastAgentChange: null,
  focusRequest: null,
  cameraRequest: null,
  error: null,
  readOnly: false,
  execute(command, actor = 'human') {
    const current = get();
    if (current.readOnly) throw new Error('This is a read-only shared project. Make an editable copy before changing it.');
    const before = cloneDoc(current.doc);
    const next = cloneDoc(current.doc);
    const result = applySceneCommand(next, command);
    finishMutation(next, current.doc.revision);
    recordFeature(next, command, result.label, result.objectIds, actor);
    const selection = result.objectIds.filter((id) => next.objects.some((object) => object.id === id)).slice(0, 1);
    set({
      doc: next,
      history: [...current.history, before].slice(-100),
      future: [],
      selection,
      activity: [activity(actor, result.label, result.objectIds), ...current.activity].slice(0, 80),
      lastAgentChange: actor === 'agent' ? { token: Date.now(), objectIds: result.objectIds } : current.lastAgentChange,
      saveState: 'saving',
      error: null,
    });
    return result;
  },
  previewTransaction(commands) {
    if (!commands.length || commands.length > 50) throw new Error('A transaction must contain between 1 and 50 operations.');
    const state = get();
    const next = cloneDoc(state.doc);
    const results = commands.map((command) => applySceneCommand(next, command));
    const affectedObjectIds = unique(results.flatMap((result) => result.objectIds));
    return {
      revision: state.doc.revision,
      summary: `Previewed ${commands.length} operation${commands.length === 1 ? '' : 's'} without changing the scene`,
      labels: results.map((result) => result.label),
      affectedObjectIds,
      objects: affectedObjectIds.map((id) => next.objects.find((object) => object.id === id)).filter(Boolean) as StudioObject[],
    };
  },
  executeTransaction(commands, actor = 'human', label, options) {
    if (!commands.length || commands.length > 50) throw new Error('A transaction must contain between 1 and 50 operations.');
    const current = get();
    if (current.readOnly) throw new Error('This is a read-only shared project. Make an editable copy before changing it.');
    const before = cloneDoc(current.doc);
    const next = cloneDoc(current.doc);
    const results = commands.map((command) => applySceneCommand(next, command));
    const objectIds = unique(results.flatMap((result) => result.objectIds));
    const resultLabel = label?.trim().slice(0, 120) || `Applied ${commands.length} scene operation${commands.length === 1 ? '' : 's'}`;
    finishMutation(next, current.doc.revision);
    commands.forEach((command, index) => recordFeature(next, command, results[index].label, results[index].objectIds, actor));
    set({
      doc: next,
      history: [...current.history, before].slice(-100),
      future: [],
      selection: options?.preserveSelection ? current.selection : objectIds.filter((id) => next.objects.some((object) => object.id === id)).slice(0, 1),
      activity: [activity(actor, resultLabel, objectIds), ...current.activity].slice(0, 80),
      lastAgentChange: actor === 'agent' ? { token: Date.now(), objectIds } : current.lastAgentChange,
      saveState: 'saving',
      error: null,
    });
    return { objectIds, label: resultLabel };
  },
  select(objectIds, actor = 'human') {
    const valid = [...new Set(objectIds)].filter((id) => get().doc.objects.some((object) => object.id === id));
    set((state) => ({
      selection: valid,
      activity: actor === 'agent' ? [activity(actor, `Selected ${valid.length || 'no'} object${valid.length === 1 ? '' : 's'}`, valid), ...state.activity].slice(0, 80) : state.activity,
    }));
  },
  focus(objectIds, actor = 'human') {
    const valid = objectIds.filter((id) => get().doc.objects.some((object) => object.id === id));
    if (!valid.length) throw new Error('No valid objects to focus.');
    set((state) => ({
      focusRequest: { token: Date.now(), objectIds: valid },
      activity: actor === 'agent' ? [activity(actor, 'Focused the viewport', valid), ...state.activity].slice(0, 80) : state.activity,
    }));
  },
  undo(actor = 'human') {
    const state = get();
    if (state.readOnly) throw new Error('This is a read-only shared project. Make an editable copy before changing it.');
    const previous = state.history.at(-1);
    if (!previous) return false;
    const restored = cloneDoc(previous);
    finishMutation(restored, state.doc.revision);
    set({
      doc: restored,
      history: state.history.slice(0, -1),
      future: [cloneDoc(state.doc), ...state.future].slice(0, 100),
      selection: state.selection.filter((id) => restored.objects.some((item) => item.id === id)),
      activity: [activity(actor, 'Undid scene change', []), ...state.activity].slice(0, 80),
      saveState: 'saving',
    });
    return true;
  },
  redo(actor = 'human') {
    const state = get();
    if (state.readOnly) throw new Error('This is a read-only shared project. Make an editable copy before changing it.');
    const next = state.future[0];
    if (!next) return false;
    const restored = cloneDoc(next);
    finishMutation(restored, state.doc.revision);
    set({
      doc: restored,
      history: [...state.history, cloneDoc(state.doc)].slice(-100),
      future: state.future.slice(1),
      selection: state.selection.filter((id) => restored.objects.some((item) => item.id === id)),
      activity: [activity(actor, 'Redid scene change', []), ...state.activity].slice(0, 80),
      saveState: 'saving',
    });
    return true;
  },
  hydrate(doc, readOnly = false) {
    const next = doc ?? createRoverStudy();
    const initialSelection = next.objects.find((object) => object.id === 'rover-chassis')
      ?? next.objects.find((object) => object.visible && object.type !== 'group');
    set({ doc: next, selection: initialSelection ? [initialSelection.id] : [], history: [], future: [], hydrated: true, readOnly, saveState: 'saved' });
  },
  replaceDocument(doc, label = 'Imported project', readOnly = false) {
    const state = get();
    set({
      doc,
      selection: [],
      history: [...state.history, cloneDoc(state.doc)].slice(-100),
      future: [],
      activity: [activity('human', label, doc.objects.map((item) => item.id)), ...state.activity].slice(0, 80),
      readOnly,
      saveState: readOnly ? 'saved' : 'saving',
    });
  },
  openDocument(doc, label = 'Opened local project') {
    const state = get();
    set({
      doc,
      selection: [],
      history: [],
      future: [],
      activity: [activity('human', label, doc.objects.map((item) => item.id)), ...state.activity].slice(0, 80),
      readOnly: false,
      saveState: 'saved',
    });
  },
  createEditableCopy(title) {
    const state = get();
    if (!state.readOnly) throw new Error('The current project is already editable.');
    const doc = makeEditableCopy(state.doc, title);
    set({
      doc,
      selection: [],
      history: [],
      future: [],
      readOnly: false,
      saveState: 'saving',
      activity: [activity('human', 'Created an editable local copy', doc.objects.map((item) => item.id)), ...state.activity].slice(0, 80),
    });
    return doc;
  },
  setToolMode(toolMode) { set({ toolMode }); },
  setSnapEnabled(enabled) {
    get().execute({ type: 'set_snap', enabled });
  },
  setCameraPreset(preset) { set({ cameraRequest: { token: Date.now(), preset } }); },
  setWebMcpStatus(webmcpStatus) { set({ webmcpStatus }); },
  setSaveState(saveState) { set({ saveState }); },
  setError(error) { set({ error }); },
  startAgentTask(agentTask, agentTaskAbort) { set({ agentTask, agentTaskAbort }); },
  finishAgentTask(token, status, durationMs, objectIds = [], error) {
    set((state) => {
      if (state.agentTask.token !== token) return state;
      const activityIndex = state.activity.findLastIndex((entry) => entry.actor === 'agent' && entry.timestamp >= state.agentTask.startedAt);
      const nextActivity = activityIndex < 0 ? state.activity : state.activity.map((entry, index) => index === activityIndex ? { ...entry, durationMs } : entry);
      return {
        agentTask: { ...state.agentTask, status, durationMs, affectedObjectIds: objectIds, error },
        agentTaskAbort: null,
        activity: nextActivity,
      };
    });
  },
  cancelAgentTask() {
    const controller = get().agentTaskAbort;
    if (controller && !controller.signal.aborted) controller.abort(new DOMException('Cancelled in SynMod.', 'AbortError'));
  },
}));

export function getObjectSnapshot(objectId: string) {
  const object = useStudioStore.getState().doc.objects.find((item) => item.id === objectId);
  return object ? structuredClone(object) : null;
}

export function getSceneHealth(doc = useStudioStore.getState().doc) {
  return analyzeScene(doc);
}

export function getCheckpointComparison(checkpointId: string) {
  const doc = useStudioStore.getState().doc;
  const checkpoint = doc.checkpoints.find((item) => item.id === checkpointId);
  if (!checkpoint) throw new Error(`Checkpoint not found: ${checkpointId}`);
  return compareCheckpoint(doc, checkpoint);
}
