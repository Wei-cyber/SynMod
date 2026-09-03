import { z } from 'zod';

import { buildFeatureTree, compactObjectSnapshot, getObjectWorldBounds } from '@/lib/scene-analysis';
import { dependencyClosure, findSceneObjects, objectIndexEntry, relativePosition, resolveObjectTarget, type ObjectTarget, type RelativePlacement } from '@/lib/scene-targeting';
import { createReadOnlyShareUrl } from '@/lib/share-links';
import { applySceneCommand, getCheckpointComparison, getObjectSnapshot, getSceneHealth, useStudioStore } from '@/lib/studio-store';
import { createId, DEFAULT_GEOMETRY, DEFAULT_MATERIAL, makeObject, type EnvironmentPreset, type ObjectType, type PrimitiveGeometry, type SceneCommand, type SceneDocument, type StudioMaterial, type Vec3 } from '@/lib/studio-types';

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const vec3Schema = {
  type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3,
  description: 'Exactly three finite numbers in X, Y, Z order.',
};
const objectIdSchema = { type: 'string', minLength: 1, description: 'Stable object ID from get_scene_summary or get_selection.' };
const expectedRevisionSchema = { type: 'integer', minimum: 0, description: 'Required safety boundary. Read the current revision immediately before this operation.' };
const primitiveEnum = ['box', 'sphere', 'cylinder', 'cone', 'torus'];
const environmentEnum = ['studio', 'sunset', 'warehouse', 'night'];
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const objectId = z.string().min(1);
const hex = z.string().regex(/^#[0-9a-f]{6}$/i);

const geometryProperties = {
  width: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
  height: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
  depth: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
  radius: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
  radius_top: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
  radius_bottom: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
  tube: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
  radial_segments: { type: 'integer', minimum: 3, maximum: 256 },
  height_segments: { type: 'integer', minimum: 1, maximum: 128 },
};
const materialProperties = {
  color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
  roughness: { type: 'number', minimum: 0, maximum: 1 },
  metalness: { type: 'number', minimum: 0, maximum: 1 },
  opacity: { type: 'number', minimum: 0, maximum: 1 },
  emissive: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
  emissive_intensity: { type: 'number', minimum: 0, maximum: 10 },
  wireframe: { type: 'boolean' },
  base_color_texture: { type: 'string', pattern: '^data:image/' },
  normal_texture: { type: 'string', pattern: '^data:image/' },
  roughness_texture: { type: 'string', pattern: '^data:image/' },
  metalness_texture: { type: 'string', pattern: '^data:image/' },
};

const geometryInput = z.object({
  width: z.number().positive().max(1000).optional(), height: z.number().positive().max(1000).optional(), depth: z.number().positive().max(1000).optional(),
  radius: z.number().positive().max(1000).optional(), radius_top: z.number().positive().max(1000).optional(), radius_bottom: z.number().positive().max(1000).optional(), tube: z.number().positive().max(1000).optional(),
  radial_segments: z.number().int().min(3).max(256).optional(), height_segments: z.number().int().min(1).max(128).optional(),
});
const materialInput = z.object({
  color: hex.optional(), roughness: z.number().min(0).max(1).optional(), metalness: z.number().min(0).max(1).optional(), opacity: z.number().min(0).max(1).optional(),
  emissive: hex.optional(), emissive_intensity: z.number().min(0).max(10).optional(), wireframe: z.boolean().optional(),
  base_color_texture: z.string().startsWith('data:image/').max(8_000_000).optional(), normal_texture: z.string().startsWith('data:image/').max(8_000_000).optional(),
  roughness_texture: z.string().startsWith('data:image/').max(8_000_000).optional(), metalness_texture: z.string().startsWith('data:image/').max(8_000_000).optional(),
});

function geometryPatch(input: z.infer<typeof geometryInput>): Partial<PrimitiveGeometry> {
  return {
    width: input.width, height: input.height, depth: input.depth, radius: input.radius,
    radiusTop: input.radius_top, radiusBottom: input.radius_bottom, tube: input.tube,
    radialSegments: input.radial_segments, heightSegments: input.height_segments,
  };
}

function materialPatch(input: z.infer<typeof materialInput>): Partial<StudioMaterial> {
  return {
    color: input.color, roughness: input.roughness, metalness: input.metalness, opacity: input.opacity,
    emissive: input.emissive, emissiveIntensity: input.emissive_intensity, wireframe: input.wireframe,
    baseColorTexture: input.base_color_texture, normalTexture: input.normal_texture,
    roughnessTexture: input.roughness_texture, metalnessTexture: input.metalness_texture,
  };
}

function response(summary: string, objectIds: string[] = []) {
  const state = useStudioStore.getState();
  const objects = objectIds.map(getObjectSnapshot).map(compactObjectSnapshot).filter(Boolean);
  const payload = { ok: true, summary, revision: state.doc.revision, affectedObjectIds: objectIds, objects };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function versionResponse(summary: string) {
  const state = useStudioStore.getState();
  const payload = {
    ok: true,
    summary,
    revision: state.doc.revision,
    project: { projectId: state.doc.projectId, title: state.doc.title, branch: state.doc.branch },
    checkpoints: state.doc.checkpoints.map(({ id, name, createdAt, sourceRevision }) => ({ id, name, createdAt, sourceRevision })),
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function run(command: SceneCommand) {
  const result = useStudioStore.getState().execute(command, 'agent');
  return response(result.label, result.objectIds);
}

type ToolAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
};

type ToolExecuteOptions = { signal: AbortSignal };

export class SceneConflictError extends Error {
  readonly code = 'scene_conflict';
  constructor(
    message: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
    readonly conflictingObjectIds: string[],
  ) {
    super(message);
    this.name = 'SceneConflictError';
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('The tool execution was cancelled.', 'AbortError');
}

function combinedSignal(signals: AbortSignal[]) {
  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const abort = () => controller.abort(signal.reason ?? new DOMException('The tool execution was cancelled.', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return { signal, abort };
  });
  return {
    signal: controller.signal,
    dispose: () => listeners.forEach(({ signal, abort }) => signal.removeEventListener('abort', abort)),
  };
}

function resultObjectIds(value: unknown) {
  if (!value || typeof value !== 'object' || !('structuredContent' in value)) return [];
  const structured = (value as { structuredContent?: { affectedObjectIds?: unknown } }).structuredContent;
  return Array.isArray(structured?.affectedObjectIds) ? structured.affectedObjectIds.filter((id): id is string => typeof id === 'string') : [];
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('The tool execution was cancelled.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function requireBrowserConfirmation(message: string, signal: AbortSignal) {
  throwIfAborted(signal);
  if (typeof window !== 'undefined' && !window.confirm(message)) {
    throw new DOMException('The person did not approve this tool action.', 'NotAllowedError');
  }
  throwIfAborted(signal);
}

function titleForTool(name: string) {
  return name.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  execute: (input: object, options: ToolExecuteOptions) => unknown,
  annotations: ToolAnnotations = {},
) {
  const title = titleForTool(name);
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: annotations.readOnlyHint ?? false,
      untrustedContentHint: annotations.untrustedContentHint ?? true,
    },
    execute: async (input: object, options?: ToolExecuteOptions) => {
      const hostSignal = options?.signal ?? new AbortController().signal;
      const localController = new AbortController();
      const combined = combinedSignal([hostSignal, localController.signal]);
      const token = createId('agent-task');
      const startedAt = Date.now();
      useStudioStore.getState().startAgentTask({ token, title, status: 'running', startedAt, affectedObjectIds: [] }, localController);
      try {
        throwIfAborted(combined.signal);
        const value = await execute(input, { signal: combined.signal });
        useStudioStore.getState().finishAgentTask(token, 'applied', Date.now() - startedAt, resultObjectIds(value));
        return value;
      } catch (error) {
        const status = error instanceof SceneConflictError ? 'conflict' : error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed';
        useStudioStore.getState().finishAgentTask(token, status, Date.now() - startedAt, error instanceof SceneConflictError ? error.conflictingObjectIds : [], error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        combined.dispose();
      }
    },
  } satisfies WebMcpToolDefinition;
}

function requireCurrentRevision(expectedRevision: number) {
  const revision = useStudioStore.getState().doc.revision;
  if (revision !== expectedRevision) throw new Error(`Scene revision mismatch. Expected ${expectedRevision}, current revision is ${revision}. Read the scene again before retrying.`);
}

function requireExistingObjectIds(ids: string[]) {
  const available = new Set(useStudioStore.getState().doc.objects.map((object) => object.id));
  const missing = [...new Set(ids)].filter((id) => !available.has(id));
  if (missing.length) throw new Error(`Object${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}`);
}

const transactionInputSchema = {
  type: 'object',
  properties: {
    expected_revision: { type: 'integer', minimum: 0, description: 'Required for apply; obtain it from get_scene_summary or preview_scene_transaction.' },
    label: { type: 'string', maxLength: 120 },
    operations: {
      type: 'array', minItems: 1, maxItems: 20,
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add_primitive', 'set_transform', 'set_geometry', 'set_material', 'set_visibility', 'boolean', 'rename'] },
          object_id: objectIdSchema, primitive_type: { type: 'string', enum: primitiveEnum }, name: { type: 'string', maxLength: 80 },
          position: vec3Schema, rotation_degrees: vec3Schema, scale: vec3Schema,
          geometry: { type: 'object', properties: geometryProperties, additionalProperties: false },
          material: { type: 'object', properties: materialProperties, additionalProperties: false },
          visible: { type: 'boolean' }, operation: { type: 'string', enum: ['union', 'subtract', 'intersect'] },
          operand_ids: { type: 'array', items: objectIdSchema, minItems: 2, maxItems: 2 },
        },
        required: ['action'], additionalProperties: false,
      },
    },
  },
  required: ['operations'], additionalProperties: false,
};

const transactionOperation = z.object({
  action: z.enum(['add_primitive', 'set_transform', 'set_geometry', 'set_material', 'set_visibility', 'boolean', 'rename']),
  object_id: objectId.optional(), primitive_type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus']).optional(), name: z.string().max(80).optional(),
  position: vec3.optional(), rotation_degrees: vec3.optional(), scale: vec3.optional(),
  geometry: geometryInput.optional(), material: materialInput.optional(), visible: z.boolean().optional(),
  operation: z.enum(['union', 'subtract', 'intersect']).optional(), operand_ids: z.tuple([objectId, objectId]).optional(),
});
const transactionSchema = z.object({ expected_revision: z.number().int().nonnegative().optional(), label: z.string().max(120).optional(), operations: z.array(transactionOperation).min(1).max(20) });

const objectTargetProperties = {
  object_id: objectIdSchema,
  name: { type: 'string', minLength: 1, maxLength: 80 },
  temp_ref: { type: 'string', minLength: 1, maxLength: 80 },
};
const objectTargetJsonSchema = {
  type: 'object',
  properties: objectTargetProperties,
  oneOf: [{ required: ['object_id'] }, { required: ['name'] }, { required: ['temp_ref'] }],
  additionalProperties: false,
};
const objectTargetInput = z.object({
  object_id: objectId.optional(),
  name: z.string().min(1).max(80).optional(),
  temp_ref: z.string().min(1).max(80).optional(),
}).refine((value) => [value.object_id, value.name, value.temp_ref].filter((item) => item !== undefined).length === 1, 'Provide exactly one of object_id, name, or temp_ref.');

const relativePlacementProperties = {
  target: objectTargetJsonSchema,
  placement: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'front', 'back', 'center'] },
  gap: { type: 'number', minimum: -1000, maximum: 1000 },
  inherit_material: { type: 'boolean' },
};
const relativePlacementInput = z.object({
  target: objectTargetInput,
  placement: z.enum(['top', 'bottom', 'left', 'right', 'front', 'back', 'center']).default('top'),
  gap: z.number().min(-1000).max(1000).default(0),
  inherit_material: z.boolean().default(false),
});

const fastOperationJsonSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add_primitive', 'set_transform', 'set_geometry', 'set_material', 'set_visibility', 'rename', 'duplicate', 'boolean', 'group', 'ungroup', 'set_environment'] },
    target: objectTargetJsonSchema,
    targets: { type: 'array', items: objectTargetJsonSchema, minItems: 2, uniqueItems: true },
    operands: { type: 'array', items: objectTargetJsonSchema, minItems: 2, maxItems: 2 },
    primitive_type: { type: 'string', enum: primitiveEnum },
    name: { type: 'string', maxLength: 80 },
    result_ref: { type: 'string', minLength: 1, maxLength: 80 },
    position: vec3Schema,
    rotation_degrees: vec3Schema,
    scale: vec3Schema,
    offset: vec3Schema,
    geometry: { type: 'object', properties: geometryProperties, additionalProperties: false },
    material: { type: 'object', properties: materialProperties, additionalProperties: false },
    visible: { type: 'boolean' },
    operation: { type: 'string', enum: ['union', 'subtract', 'intersect'] },
    relative_to: { type: 'object', properties: relativePlacementProperties, required: ['target'], additionalProperties: false },
    environment: { type: 'string', enum: environmentEnum },
    exposure: { type: 'number', minimum: 0.1, maximum: 3 },
    background_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
    shadows: { type: 'boolean' },
  },
  required: ['action'],
  additionalProperties: false,
};

const fastOperationInput = z.object({
  action: z.enum(['add_primitive', 'set_transform', 'set_geometry', 'set_material', 'set_visibility', 'rename', 'duplicate', 'boolean', 'group', 'ungroup', 'set_environment']),
  target: objectTargetInput.optional(),
  targets: z.array(objectTargetInput).min(2).optional(),
  operands: z.tuple([objectTargetInput, objectTargetInput]).optional(),
  primitive_type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus']).optional(),
  name: z.string().max(80).optional(),
  result_ref: z.string().min(1).max(80).optional(),
  position: vec3.optional(), rotation_degrees: vec3.optional(), scale: vec3.optional(), offset: vec3.optional(),
  geometry: geometryInput.optional(), material: materialInput.optional(), visible: z.boolean().optional(),
  operation: z.enum(['union', 'subtract', 'intersect']).optional(), relative_to: relativePlacementInput.optional(),
  environment: z.enum(['studio', 'sunset', 'warehouse', 'night']).optional(), exposure: z.number().min(0.1).max(3).optional(), background_color: hex.optional(), shadows: z.boolean().optional(),
});

const fastTransactionInput = z.object({
  expected_revision: z.number().int().nonnegative().optional(),
  label: z.string().max(120).optional(),
  operations: z.array(fastOperationInput).min(1).max(50),
  select_after: z.array(objectTargetInput).max(100).optional(),
  focus_after: z.array(objectTargetInput).min(1).max(100).optional(),
});

function targetValue(input: z.infer<typeof objectTargetInput>): ObjectTarget {
  return { objectId: input.object_id, name: input.name, tempRef: input.temp_ref };
}

function makeRelativeAddCommand(
  doc: SceneDocument,
  temporaryIds: Map<string, string>,
  input: {
    primitiveType: 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus';
    name?: string;
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
    geometry?: Partial<PrimitiveGeometry>;
    material?: Partial<StudioMaterial>;
    relativeTo?: z.infer<typeof relativePlacementInput>;
    objectId?: string;
  },
) {
  const objectIdValue = input.objectId ?? createId();
  let material = input.material;
  let position = input.position;
  let anchorId: string | undefined;
  if (input.relativeTo) {
    const anchor = resolveObjectTarget(doc, targetValue(input.relativeTo.target), temporaryIds);
    anchorId = anchor.id;
    if (input.relativeTo.inherit_material) {
      const explicitMaterial = Object.fromEntries(Object.entries(material ?? {}).filter(([, value]) => value !== undefined)) as Partial<StudioMaterial>;
      material = { ...anchor.material, ...explicitMaterial };
    }
    const prototype = makeObject(input.primitiveType, input.name ?? input.primitiveType, {
      id: objectIdValue,
      position: [0, 0, 0],
      rotation: input.rotation ?? [0, 0, 0],
      scale: input.scale ?? [1, 1, 1],
      geometry: { ...DEFAULT_GEOMETRY, ...(input.primitiveType === 'cone' ? { radiusTop: 0.02 } : {}), ...input.geometry },
      material: { ...DEFAULT_MATERIAL, ...material },
    });
    const prototypeDoc = structuredClone(doc);
    prototypeDoc.objects.push(prototype);
    const targetBounds = getObjectWorldBounds(doc, anchor.id);
    const prototypeBounds = getObjectWorldBounds(prototypeDoc, prototype.id);
    if (!targetBounds) throw new Error(`${anchor.name} does not expose usable world bounds for relative placement.`);
    if (!prototypeBounds) throw new Error('The new primitive does not expose usable bounds.');
    position = relativePosition(targetBounds, prototypeBounds, input.relativeTo.placement as RelativePlacement, input.relativeTo.gap);
  }
  return {
    command: {
      type: 'add_primitive', primitiveType: input.primitiveType, name: input.name, position, rotation: input.rotation, scale: input.scale,
      geometry: input.geometry, material, objectId: objectIdValue,
    } satisfies SceneCommand,
    anchorId,
  };
}

function reserveResultId(resultRef: string | undefined, temporaryIds: Map<string, string>) {
  const id = createId();
  if (!resultRef) return id;
  if (temporaryIds.has(resultRef)) throw new Error(`Temporary object reference is already in use: ${resultRef}`);
  temporaryIds.set(resultRef, id);
  return id;
}

function compileFastTransaction(doc: SceneDocument, operations: z.infer<typeof fastOperationInput>[]) {
  const working = structuredClone(doc);
  const temporaryIds = new Map<string, string>();
  const commands: SceneCommand[] = [];
  const dependencyIds = new Set<string>();
  let settingsTouched = false;
  const resolve = (target: z.infer<typeof objectTargetInput> | undefined) => {
    if (!target) throw new Error('This operation requires a target.');
    const object = resolveObjectTarget(working, targetValue(target), temporaryIds);
    if (doc.objects.some((item) => item.id === object.id)) dependencyIds.add(object.id);
    return object;
  };
  const append = (command: SceneCommand) => {
    applySceneCommand(working, command);
    commands.push(command);
  };

  for (const operation of operations) {
    switch (operation.action) {
      case 'add_primitive': {
        if (!operation.primitive_type) throw new Error('add_primitive requires primitive_type.');
        const resultId = reserveResultId(operation.result_ref, temporaryIds);
        const built = makeRelativeAddCommand(working, temporaryIds, {
          primitiveType: operation.primitive_type, name: operation.name, position: operation.position, rotation: operation.rotation_degrees,
          scale: operation.scale, geometry: operation.geometry ? geometryPatch(operation.geometry) : undefined,
          material: operation.material ? materialPatch(operation.material) : undefined, relativeTo: operation.relative_to, objectId: resultId,
        });
        if (built.anchorId && doc.objects.some((item) => item.id === built.anchorId)) dependencyIds.add(built.anchorId);
        append(built.command);
        break;
      }
      case 'set_transform': {
        const object = resolve(operation.target);
        append({ type: 'set_transform', objectId: object.id, position: operation.position, rotation: operation.rotation_degrees, scale: operation.scale });
        break;
      }
      case 'set_geometry': {
        const object = resolve(operation.target);
        if (!operation.geometry) throw new Error('set_geometry requires geometry.');
        append({ type: 'set_geometry', objectId: object.id, geometry: geometryPatch(operation.geometry) });
        break;
      }
      case 'set_material': {
        const object = resolve(operation.target);
        if (!operation.material) throw new Error('set_material requires material.');
        append({ type: 'set_material', objectId: object.id, material: materialPatch(operation.material) });
        break;
      }
      case 'set_visibility': {
        const object = resolve(operation.target);
        if (operation.visible === undefined) throw new Error('set_visibility requires visible.');
        append({ type: 'set_visibility', objectId: object.id, visible: operation.visible });
        break;
      }
      case 'rename': {
        const object = resolve(operation.target);
        if (!operation.name) throw new Error('rename requires name.');
        append({ type: 'rename', objectId: object.id, name: operation.name });
        break;
      }
      case 'duplicate': {
        const object = resolve(operation.target);
        append({ type: 'duplicate', objectId: object.id, name: operation.name, offset: operation.offset, resultId: reserveResultId(operation.result_ref, temporaryIds) });
        break;
      }
      case 'boolean': {
        if (!operation.operands || !operation.operation) throw new Error('boolean requires two operands and an operation.');
        const operands = operation.operands.map((target) => resolve(target));
        append({ type: 'boolean', operation: operation.operation, operandIds: [operands[0].id, operands[1].id], name: operation.name, resultId: reserveResultId(operation.result_ref, temporaryIds) });
        break;
      }
      case 'group': {
        if (!operation.targets) throw new Error('group requires targets.');
        const targets = operation.targets.map((target) => resolve(target));
        append({ type: 'group', objectIds: targets.map((object) => object.id), name: operation.name, resultId: reserveResultId(operation.result_ref, temporaryIds) });
        break;
      }
      case 'ungroup': {
        const object = resolve(operation.target);
        append({ type: 'ungroup', groupId: object.id });
        break;
      }
      case 'set_environment': {
        settingsTouched = true;
        append({ type: 'set_environment', environment: operation.environment as EnvironmentPreset | undefined, exposure: operation.exposure, backgroundColor: operation.background_color, shadows: operation.shadows });
        break;
      }
    }
  }
  return { commands, temporaryIds, dependencyIds, settingsTouched };
}

function assertTransactionCanRebase(doc: SceneDocument, expectedRevision: number | undefined, dependencyIds: Set<string>, settingsTouched: boolean) {
  if (expectedRevision === undefined || expectedRevision === doc.revision) return;
  if (expectedRevision > doc.revision) throw new SceneConflictError(`Expected revision ${expectedRevision} is newer than the current scene revision ${doc.revision}.`, expectedRevision, doc.revision, []);
  const laterFeatures = doc.features.filter((feature) => feature.revision > expectedRevision);
  if (!laterFeatures.length) throw new SceneConflictError('The scene changed outside the retained feature history, so this transaction cannot be safely rebased.', expectedRevision, doc.revision, []);
  const dependencies = dependencyClosure(doc, dependencyIds);
  const conflicts = [...new Set(laterFeatures.flatMap((feature) => feature.objectIds).filter((id) => dependencies.has(id)))];
  const settingsConflict = settingsTouched && laterFeatures.some((feature) => feature.kind === 'environment');
  if (conflicts.length || settingsConflict) {
    throw new SceneConflictError(`Scene conflict at revision ${doc.revision}. Read the conflicting objects and retry.`, expectedRevision, doc.revision, conflicts);
  }
}

function operationToCommand(operation: z.infer<typeof transactionOperation>): SceneCommand {
  switch (operation.action) {
    case 'add_primitive':
      if (!operation.primitive_type) throw new Error('add_primitive requires primitive_type.');
      return { type: 'add_primitive', primitiveType: operation.primitive_type, name: operation.name, position: operation.position, rotation: operation.rotation_degrees, scale: operation.scale, geometry: operation.geometry ? geometryPatch(operation.geometry) : undefined, material: operation.material ? materialPatch(operation.material) : undefined };
    case 'set_transform':
      if (!operation.object_id || (!operation.position && !operation.rotation_degrees && !operation.scale)) throw new Error('set_transform requires object_id and at least one transform property.');
      return { type: 'set_transform', objectId: operation.object_id, position: operation.position, rotation: operation.rotation_degrees, scale: operation.scale };
    case 'set_geometry':
      if (!operation.object_id || !operation.geometry) throw new Error('set_geometry requires object_id and geometry.');
      if (!Object.values(geometryPatch(operation.geometry)).some((value) => value !== undefined)) throw new Error('set_geometry requires at least one geometry value.');
      return { type: 'set_geometry', objectId: operation.object_id, geometry: geometryPatch(operation.geometry) };
    case 'set_material':
      if (!operation.object_id || !operation.material) throw new Error('set_material requires object_id and material.');
      if (!Object.values(materialPatch(operation.material)).some((value) => value !== undefined)) throw new Error('set_material requires at least one material value.');
      return { type: 'set_material', objectId: operation.object_id, material: materialPatch(operation.material) };
    case 'set_visibility':
      if (!operation.object_id || operation.visible === undefined) throw new Error('set_visibility requires object_id and visible.');
      return { type: 'set_visibility', objectId: operation.object_id, visible: operation.visible };
    case 'boolean':
      if (!operation.operation || !operation.operand_ids) throw new Error('boolean requires operation and two operand_ids.');
      return { type: 'boolean', operation: operation.operation, operandIds: operation.operand_ids, name: operation.name };
    case 'rename':
      if (!operation.object_id || !operation.name) throw new Error('rename requires object_id and name.');
      return { type: 'rename', objectId: operation.object_id, name: operation.name };
  }
}

export async function registerWebMcpTools() {
  if (typeof document.modelContext?.registerTool !== 'function') {
    useStudioStore.getState().setWebMcpStatus('unavailable');
    return () => undefined;
  }

  useStudioStore.getState().setWebMcpStatus('checking');
  const controller = new AbortController();
  const definitions = [
    tool('get_scene_summary', 'Read the current SynMod project, revision, hierarchy, parametric geometry, transforms, materials, Boolean features, and environment without changing it.', emptySchema, () => {
      const state = useStudioStore.getState();
      const payload = { projectId: state.doc.projectId, title: state.doc.title, revision: state.doc.revision, readOnly: state.readOnly, objectCount: state.doc.objects.length, featureCount: state.doc.features.length, checkpointCount: state.doc.checkpoints.length, selection: state.selection, settings: state.doc.settings, objects: state.doc.objects.map(compactObjectSnapshot) };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('get_object', 'Read one scene object by its stable ID. This tool does not change the scene.', {
      type: 'object', properties: { object_id: objectIdSchema }, required: ['object_id'], additionalProperties: false,
    }, (input) => {
      const { object_id } = z.object({ object_id: objectId }).parse(input);
      const object = getObjectSnapshot(object_id);
      if (!object) throw new Error(`Object not found: ${object_id}`);
      const compact = compactObjectSnapshot(object);
      return { content: [{ type: 'text', text: JSON.stringify(compact) }], structuredContent: compact };
    }, { readOnlyHint: true }),
    tool('get_selection', 'Read the objects currently selected by the person in SynMod. This tool does not change the scene.', emptySchema, () => {
      const state = useStudioStore.getState();
      const objects = state.selection.map(getObjectSnapshot).map(compactObjectSnapshot).filter(Boolean);
      const payload = { revision: state.doc.revision, selectedObjectIds: state.selection, objects };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('find_objects', 'Find scene objects by normalized human-readable name, type, visibility, parent, or current selection. Returns compact IDs, transforms, and world bounds without changing the scene.', {
      type: 'object', properties: {
        query: { type: 'string', minLength: 1, maxLength: 80 },
        match: { type: 'string', enum: ['normalized_exact', 'contains'] },
        types: { type: 'array', items: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone', 'torus', 'boolean', 'group', 'glb', 'glb_node'] }, uniqueItems: true },
        visible: { type: 'boolean' },
        parent_id: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        selection_only: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      }, additionalProperties: false,
    }, (input) => {
      const parsed = z.object({
        query: z.string().min(1).max(80).optional(), match: z.enum(['normalized_exact', 'contains']).default('normalized_exact'),
        types: z.array(z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus', 'boolean', 'group', 'glb', 'glb_node'])).optional(),
        visible: z.boolean().optional(), parent_id: z.string().min(1).nullable().optional(), selection_only: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(20),
      }).parse(input);
      const state = useStudioStore.getState();
      const objects = findSceneObjects(state.doc, { query: parsed.query, match: parsed.match, types: parsed.types as ObjectType[] | undefined, visible: parsed.visible, parentId: parsed.parent_id, selectionOnly: parsed.selection_only, selectedIds: state.selection, limit: parsed.limit });
      const payload = { revision: state.doc.revision, count: objects.length, objects: objects.map((object) => objectIndexEntry(state.doc, object)) };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('inspect_scene_health', 'Inspect object counts, hidden feature inputs, imported nodes, textured objects, and modeling warnings without changing the scene.', emptySchema, () => {
      const payload = getSceneHealth();
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('get_feature_tree', 'Read the procedural feature tree and per-object operation history without changing the scene.', emptySchema, () => {
      const state = useStudioStore.getState();
      const payload = { revision: state.doc.revision, featureCount: state.doc.features.length, tree: buildFeatureTree(state.doc), timeline: state.doc.features };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('get_project_versions', 'Read local checkpoint metadata and branch ancestry without changing the scene.', emptySchema, () => {
      const state = useStudioStore.getState();
      const payload = { projectId: state.doc.projectId, title: state.doc.title, revision: state.doc.revision, branch: state.doc.branch, checkpoints: state.doc.checkpoints.map(({ id, name, createdAt, sourceRevision }) => ({ id, name, createdAt, sourceRevision })) };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('compare_checkpoint', 'Compare the current scene against a named checkpoint without changing it.', {
      type: 'object', properties: { checkpoint_id: { type: 'string', minLength: 1 } }, required: ['checkpoint_id'], additionalProperties: false,
    }, (input) => {
      const { checkpoint_id } = z.object({ checkpoint_id: z.string().min(1) }).parse(input);
      const payload = getCheckpointComparison(checkpoint_id);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('add_primitive', 'Add one parametric primitive to the live scene. The change is visible, autosaved, attributed to Agent, and reversible.', {
      type: 'object', properties: {
        primitive_type: { type: 'string', enum: primitiveEnum }, name: { type: 'string', maxLength: 80 }, position: vec3Schema, rotation_degrees: vec3Schema, scale: vec3Schema,
        geometry: { type: 'object', properties: geometryProperties, additionalProperties: false },
        material: { type: 'object', properties: materialProperties, additionalProperties: false },
        color: materialProperties.color, roughness: materialProperties.roughness, metalness: materialProperties.metalness,
        relative_to: { type: 'object', properties: relativePlacementProperties, required: ['target'], additionalProperties: false },
      }, required: ['primitive_type'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ primitive_type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus']), name: z.string().max(80).optional(), position: vec3.optional(), rotation_degrees: vec3.optional(), scale: vec3.optional(), geometry: geometryInput.optional(), material: materialInput.optional(), color: hex.optional(), roughness: z.number().min(0).max(1).optional(), metalness: z.number().min(0).max(1).optional(), relative_to: relativePlacementInput.optional() }).parse(input);
      const nestedMaterial = parsed.material ? materialPatch(parsed.material) : {};
      const material = { ...nestedMaterial, color: parsed.color ?? nestedMaterial.color, roughness: parsed.roughness ?? nestedMaterial.roughness, metalness: parsed.metalness ?? nestedMaterial.metalness };
      const built = makeRelativeAddCommand(useStudioStore.getState().doc, new Map(), { primitiveType: parsed.primitive_type, name: parsed.name, position: parsed.position, rotation: parsed.rotation_degrees, scale: parsed.scale, geometry: parsed.geometry ? geometryPatch(parsed.geometry) : undefined, material, relativeTo: parsed.relative_to });
      return run(built.command);
    }),
    tool('set_object_transform', 'Set position, rotation in degrees, or scale for one scene object. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, position: vec3Schema, rotation_degrees: vec3Schema, scale: vec3Schema }, required: ['object_id'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ object_id: objectId, position: vec3.optional(), rotation_degrees: vec3.optional(), scale: vec3.optional() }).refine((value) => value.position || value.rotation_degrees || value.scale, 'Provide at least one transform property.').parse(input);
      return run({ type: 'set_transform', objectId: parsed.object_id, position: parsed.position, rotation: parsed.rotation_degrees, scale: parsed.scale });
    }),
    tool('set_geometry_parameters', 'Refine the dimensions and segment counts of one parametric primitive. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, ...geometryProperties }, required: ['object_id'], additionalProperties: false,
    }, (input) => {
      const parsed = geometryInput.extend({ object_id: objectId }).parse(input);
      const patch = geometryPatch(parsed);
      if (!Object.values(patch).some((value) => value !== undefined)) throw new Error('Provide at least one geometry parameter.');
      return run({ type: 'set_geometry', objectId: parsed.object_id, geometry: patch });
    }),
    tool('set_object_material', 'Change PBR values or embedded texture maps for one primitive, Boolean result, or imported mesh node. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, ...materialProperties }, required: ['object_id'], additionalProperties: false,
    }, (input) => {
      const parsed = materialInput.extend({ object_id: objectId }).parse(input);
      const patch = materialPatch(parsed);
      if (!Object.values(patch).some((value) => value !== undefined)) throw new Error('Provide at least one material property.');
      return run({ type: 'set_material', objectId: parsed.object_id, material: patch });
    }),
    tool('boolean_objects', 'Create a non-destructive union, subtraction, or intersection from two primitives or Boolean results. Source operands remain in the feature graph, hidden and editable. The change is reversible.', {
      type: 'object', properties: { operation: { type: 'string', enum: ['union', 'subtract', 'intersect'] }, operand_ids: { type: 'array', items: objectIdSchema, minItems: 2, maxItems: 2 }, name: { type: 'string', maxLength: 80 } }, required: ['operation', 'operand_ids'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ operation: z.enum(['union', 'subtract', 'intersect']), operand_ids: z.tuple([objectId, objectId]), name: z.string().max(80).optional() }).parse(input);
      return run({ type: 'boolean', operation: parsed.operation, operandIds: parsed.operand_ids, name: parsed.name });
    }),
    tool('set_scene_environment', 'Change the HDRI environment preset, exposure, background color, or scene shadows. Applies immediately and is reversible.', {
      type: 'object', properties: { environment: { type: 'string', enum: environmentEnum }, exposure: { type: 'number', minimum: 0.1, maximum: 3 }, background_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }, shadows: { type: 'boolean' } }, additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ environment: z.enum(['studio', 'sunset', 'warehouse', 'night']).optional(), exposure: z.number().min(0.1).max(3).optional(), background_color: hex.optional(), shadows: z.boolean().optional() }).parse(input);
      if (parsed.environment === undefined && parsed.exposure === undefined && parsed.background_color === undefined && parsed.shadows === undefined) throw new Error('Provide at least one environment property.');
      return run({ type: 'set_environment', environment: parsed.environment, exposure: parsed.exposure, backgroundColor: parsed.background_color, shadows: parsed.shadows });
    }),
    tool('preview_scene_transaction', 'Validate and preview 1–20 modeling operations atomically without changing the scene. Use the returned revision with apply_scene_transaction.', transactionInputSchema, (input) => {
      const parsed = transactionSchema.parse(input);
      const preview = useStudioStore.getState().previewTransaction(parsed.operations.map(operationToCommand));
      const compact = { ...preview, objects: preview.objects.map(compactObjectSnapshot) };
      return { content: [{ type: 'text', text: JSON.stringify(compact) }], structuredContent: compact };
    }, { readOnlyHint: true }),
    tool('apply_scene_transaction', 'Atomically apply 1–20 previously previewable modeling operations as one visible revision and one undo step. Rejects stale expected_revision values and never partially applies.', transactionInputSchema, (input) => {
      const parsed = transactionSchema.extend({ expected_revision: z.number().int().nonnegative() }).parse(input);
      const state = useStudioStore.getState();
      if (state.doc.revision !== parsed.expected_revision) throw new Error(`Scene changed after preview. Expected revision ${parsed.expected_revision}, current revision is ${state.doc.revision}.`);
      const result = state.executeTransaction(parsed.operations.map(operationToCommand), 'agent', parsed.label);
      return response(result.label, result.objectIds);
    }),
    tool('execute_scene_transaction', 'Validate and immediately apply 1–50 safe reversible modeling operations as one visible revision and one undo step. Supports human-readable targets, temporary result references, disjoint-edit rebasing, and optional selection or focus after commit.', {
      type: 'object', properties: {
        expected_revision: { type: 'integer', minimum: 0, description: 'Optional optimistic concurrency boundary. Unrelated later edits are safely rebased.' },
        label: { type: 'string', maxLength: 120 },
        operations: { type: 'array', minItems: 1, maxItems: 50, items: fastOperationJsonSchema },
        select_after: { type: 'array', items: objectTargetJsonSchema, maxItems: 100 },
        focus_after: { type: 'array', items: objectTargetJsonSchema, minItems: 1, maxItems: 100 },
      }, required: ['operations'], additionalProperties: false,
    }, (input, { signal }) => {
      const parsed = fastTransactionInput.parse(input);
      const state = useStudioStore.getState();
      let compiled: ReturnType<typeof compileFastTransaction>;
      try {
        compiled = compileFastTransaction(state.doc, parsed.operations);
      } catch (error) {
        if (parsed.expected_revision !== undefined && parsed.expected_revision !== state.doc.revision && error instanceof Error && /not found|ambiguous|no longer exists/i.test(error.message)) {
          throw new SceneConflictError(`Scene conflict at revision ${state.doc.revision}: ${error.message}`, parsed.expected_revision, state.doc.revision, []);
        }
        throw error;
      }
      assertTransactionCanRebase(state.doc, parsed.expected_revision, compiled.dependencyIds, compiled.settingsTouched);
      throwIfAborted(signal);
      const result = state.executeTransaction(compiled.commands, 'agent', parsed.label, { preserveSelection: true });
      const committed = useStudioStore.getState();
      const resolveAfter = (targets: z.infer<typeof objectTargetInput>[] | undefined) => targets?.map((target) => resolveObjectTarget(committed.doc, targetValue(target), compiled.temporaryIds).id) ?? [];
      const selectedIds = resolveAfter(parsed.select_after);
      const focusedIds = resolveAfter(parsed.focus_after);
      if (parsed.select_after) committed.select(selectedIds, 'agent');
      if (focusedIds.length) committed.focus(focusedIds, 'agent');
      const objects = result.objectIds.map(getObjectSnapshot).map(compactObjectSnapshot).filter(Boolean);
      const payload = {
        ok: true,
        summary: result.label,
        revision: useStudioStore.getState().doc.revision,
        affectedObjectIds: result.objectIds,
        objects,
        resolvedRefs: Object.fromEntries(compiled.temporaryIds),
        rebasedFromRevision: parsed.expected_revision !== undefined && parsed.expected_revision !== state.doc.revision ? parsed.expected_revision : undefined,
        selectedObjectIds: parsed.select_after ? selectedIds : undefined,
        focusedObjectIds: parsed.focus_after ? focusedIds : undefined,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }),
    tool('create_checkpoint', 'Create a named local checkpoint of the complete editable scene. This changes project history, autosaves locally, and is reversible.', {
      type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['name'], additionalProperties: false,
    }, (input) => {
      const { name } = z.object({ name: z.string().min(1).max(80) }).parse(input);
      const result = useStudioStore.getState().execute({ type: 'create_checkpoint', name }, 'agent');
      return versionResponse(result.label);
    }),
    tool('restore_checkpoint', 'Restore all scene objects and settings from a named checkpoint. This is immediate and destructive to the current scene state, but reversible with undo. Requires the current scene revision as a stale-write safety boundary.', {
      type: 'object', properties: { checkpoint_id: { type: 'string', minLength: 1 }, expected_revision: expectedRevisionSchema }, required: ['checkpoint_id', 'expected_revision'], additionalProperties: false,
    }, (input, { signal }) => {
      const { checkpoint_id, expected_revision } = z.object({ checkpoint_id: z.string().min(1), expected_revision: z.number().int().nonnegative() }).parse(input);
      requireCurrentRevision(expected_revision);
      requireBrowserConfirmation('Allow the agent to replace the current scene with this checkpoint? You can undo the change afterward.', signal);
      requireCurrentRevision(expected_revision);
      const result = useStudioStore.getState().execute({ type: 'restore_checkpoint', checkpointId: checkpoint_id }, 'agent');
      return versionResponse(result.label);
    }),
    tool('branch_project', 'Create and switch to a new local project branch from the current scene or a checkpoint. The source project remains saved locally.', {
      type: 'object', properties: { checkpoint_id: { type: 'string', minLength: 1 }, name: { type: 'string', maxLength: 100 } }, additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ checkpoint_id: z.string().min(1).optional(), name: z.string().max(100).optional() }).parse(input);
      const result = useStudioStore.getState().execute({ type: 'branch_project', checkpointId: parsed.checkpoint_id, name: parsed.name }, 'agent');
      return versionResponse(result.label);
    }),
    tool('duplicate_project', 'Create and switch to a separate editable local copy of the current project. No cloud account is used.', {
      type: 'object', properties: { name: { type: 'string', maxLength: 100 } }, additionalProperties: false,
    }, (input) => {
      const { name } = z.object({ name: z.string().max(100).optional() }).parse(input);
      const result = useStudioStore.getState().execute({ type: 'duplicate_project', name }, 'agent');
      return versionResponse(result.label);
    }),
    tool('create_readonly_share_link', 'Create a browser-only read-only share link containing the current project. The link can expose the scene to anyone who receives it; it does not upload to cloud storage. The browser must review this external disclosure before invocation.', emptySchema, async (_input, { signal }) => {
      requireBrowserConfirmation('Allow the agent to create a link containing this complete scene? Anyone with the link can inspect it.', signal);
      const state = useStudioStore.getState();
      const url = await abortable(createReadOnlyShareUrl(state.doc), signal);
      throwIfAborted(signal);
      const payload = { ok: true, revision: state.doc.revision, summary: 'Created read-only project link', url, mode: 'read-only', storage: 'embedded-in-link' };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('rename_object', 'Rename one scene object. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['object_id', 'name'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_id: objectId, name: z.string().min(1).max(80) }).parse(input); return run({ type: 'rename', objectId: parsed.object_id, name: parsed.name }); }),
    tool('duplicate_object', 'Duplicate an object or group and offset the new copy. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, name: { type: 'string', maxLength: 80 }, offset: vec3Schema }, required: ['object_id'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_id: objectId, name: z.string().max(80).optional(), offset: vec3.optional() }).parse(input); return run({ type: 'duplicate', objectId: parsed.object_id, name: parsed.name, offset: parsed.offset }); }),
    tool('delete_object', 'Delete one object. Deleting a Boolean result restores its source operands. This destructive change is immediate but reversible with undo_scene_change. Requires the current scene revision as a stale-write safety boundary.', {
      type: 'object', properties: { object_id: objectIdSchema, expected_revision: expectedRevisionSchema }, required: ['object_id', 'expected_revision'], additionalProperties: false,
    }, (input, { signal }) => { const parsed = z.object({ object_id: objectId, expected_revision: z.number().int().nonnegative() }).parse(input); requireCurrentRevision(parsed.expected_revision); requireBrowserConfirmation('Allow the agent to delete this object? You can undo the change afterward.', signal); requireCurrentRevision(parsed.expected_revision); return run({ type: 'delete', objectId: parsed.object_id }); }),
    tool('group_objects', 'Create a transformable group from two or more objects that share the same parent. Applies immediately and is reversible.', {
      type: 'object', properties: { object_ids: { type: 'array', items: objectIdSchema, minItems: 2, uniqueItems: true }, name: { type: 'string', maxLength: 80 } }, required: ['object_ids'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_ids: z.array(objectId).min(2), name: z.string().max(80).optional() }).parse(input); return run({ type: 'group', objectIds: parsed.object_ids, name: parsed.name }); }),
    tool('ungroup_object', 'Remove one group while preserving its children and visible world transforms. Applies immediately and is reversible.', {
      type: 'object', properties: { group_id: objectIdSchema }, required: ['group_id'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ group_id: objectId }).parse(input); return run({ type: 'ungroup', groupId: parsed.group_id }); }),
    tool('select_objects', 'Change the current selection so the person can inspect requested objects. This does not change model geometry.', {
      type: 'object', properties: { object_ids: { type: 'array', items: objectIdSchema, uniqueItems: true } }, required: ['object_ids'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_ids: z.array(objectId) }).parse(input); requireExistingObjectIds(parsed.object_ids); useStudioStore.getState().select(parsed.object_ids, 'agent'); return response(`Selected ${parsed.object_ids.length} object${parsed.object_ids.length === 1 ? '' : 's'}`, parsed.object_ids); }),
    tool('focus_objects', 'Move the viewport camera to frame existing objects. This does not change model geometry.', {
      type: 'object', properties: { object_ids: { type: 'array', items: objectIdSchema, minItems: 1, uniqueItems: true } }, required: ['object_ids'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_ids: z.array(objectId).min(1) }).parse(input); requireExistingObjectIds(parsed.object_ids); useStudioStore.getState().focus(parsed.object_ids, 'agent'); return response('Focused the viewport', parsed.object_ids); }),
    tool('undo_scene_change', 'Undo the most recent reversible modeling change and update the live scene immediately. Requires the current scene revision as a stale-write safety boundary.', {
      type: 'object', properties: { expected_revision: expectedRevisionSchema }, required: ['expected_revision'], additionalProperties: false,
    }, (input) => { const { expected_revision } = z.object({ expected_revision: z.number().int().nonnegative() }).parse(input); requireCurrentRevision(expected_revision); if (!useStudioStore.getState().undo('agent')) throw new Error('There is no scene change to undo.'); return response('Undid the most recent scene change'); }),
    tool('redo_scene_change', 'Redo the next modeling change in history and update the live scene immediately. Requires the current scene revision as a stale-write safety boundary.', {
      type: 'object', properties: { expected_revision: expectedRevisionSchema }, required: ['expected_revision'], additionalProperties: false,
    }, (input) => { const { expected_revision } = z.object({ expected_revision: z.number().int().nonnegative() }).parse(input); requireCurrentRevision(expected_revision); if (!useStudioStore.getState().redo('agent')) throw new Error('There is no scene change to redo.'); return response('Redid the next scene change'); }),
  ];

  try {
    await Promise.all(definitions.map((definition) => {
      if (!document.modelContext) throw new Error('WebMCP became unavailable during registration.');
      return document.modelContext.registerTool(definition, { signal: controller.signal });
    }));
    useStudioStore.getState().setWebMcpStatus('ready');
  } catch (error) {
    controller.abort();
    useStudioStore.getState().setWebMcpStatus('error');
    throw error;
  }
  return () => controller.abort();
}
