import { z } from 'zod';

import { getObjectSnapshot, getSceneHealth, useStudioStore } from '@/lib/studio-store';
import type { PrimitiveGeometry, SceneCommand, StudioMaterial } from '@/lib/studio-types';

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const vec3Schema = {
  type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3,
  description: 'Exactly three finite numbers in X, Y, Z order.',
};
const objectIdSchema = { type: 'string', minLength: 1, description: 'Stable object ID from get_scene_summary or get_selection.' };
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
  const objects = objectIds.map(getObjectSnapshot).filter(Boolean);
  const payload = { ok: true, summary, revision: state.doc.revision, affectedObjectIds: objectIds, objects };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function run(command: SceneCommand) {
  const result = useStudioStore.getState().execute(command, 'agent');
  return response(result.label, result.objectIds);
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  execute: (input: unknown) => unknown,
  annotations: Record<string, boolean> = { readOnlyHint: false },
) {
  return { name, description, inputSchema, annotations, execute };
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
  const modelContext = document.modelContext;
  if (typeof modelContext?.registerTool !== 'function') {
    useStudioStore.getState().setWebMcpStatus('unavailable');
    return () => undefined;
  }

  useStudioStore.getState().setWebMcpStatus('checking');
  const controller = new AbortController();
  const definitions = [
    tool('get_scene_summary', 'Read the current Model Room project, revision, hierarchy, parametric geometry, transforms, materials, Boolean features, and environment without changing it.', emptySchema, () => {
      const state = useStudioStore.getState();
      const payload = { title: state.doc.title, revision: state.doc.revision, objectCount: state.doc.objects.length, selection: state.selection, settings: state.doc.settings, objects: state.doc.objects };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('get_object', 'Read one scene object by its stable ID. This tool does not change the scene.', {
      type: 'object', properties: { object_id: objectIdSchema }, required: ['object_id'], additionalProperties: false,
    }, (input) => {
      const { object_id } = z.object({ object_id: objectId }).parse(input);
      const object = getObjectSnapshot(object_id);
      if (!object) throw new Error(`Object not found: ${object_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(object) }], structuredContent: object };
    }, { readOnlyHint: true }),
    tool('get_selection', 'Read the objects currently selected by the person in Model Room. This tool does not change the scene.', emptySchema, () => {
      const state = useStudioStore.getState();
      const objects = state.selection.map(getObjectSnapshot).filter(Boolean);
      const payload = { revision: state.doc.revision, selectedObjectIds: state.selection, objects };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('inspect_scene_health', 'Inspect object counts, hidden feature inputs, imported nodes, textured objects, and modeling warnings without changing the scene.', emptySchema, () => {
      const payload = getSceneHealth();
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }, { readOnlyHint: true }),
    tool('add_primitive', 'Add one parametric primitive to the live scene. The change is visible, autosaved, attributed to Agent, and reversible.', {
      type: 'object', properties: {
        primitive_type: { type: 'string', enum: primitiveEnum }, name: { type: 'string', maxLength: 80 }, position: vec3Schema, rotation_degrees: vec3Schema, scale: vec3Schema,
        geometry: { type: 'object', properties: geometryProperties, additionalProperties: false },
        material: { type: 'object', properties: materialProperties, additionalProperties: false },
        color: materialProperties.color, roughness: materialProperties.roughness, metalness: materialProperties.metalness,
      }, required: ['primitive_type'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ primitive_type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus']), name: z.string().max(80).optional(), position: vec3.optional(), rotation_degrees: vec3.optional(), scale: vec3.optional(), geometry: geometryInput.optional(), material: materialInput.optional(), color: hex.optional(), roughness: z.number().min(0).max(1).optional(), metalness: z.number().min(0).max(1).optional() }).parse(input);
      const nestedMaterial = parsed.material ? materialPatch(parsed.material) : {};
      return run({ type: 'add_primitive', primitiveType: parsed.primitive_type, name: parsed.name, position: parsed.position, rotation: parsed.rotation_degrees, scale: parsed.scale, geometry: parsed.geometry ? geometryPatch(parsed.geometry) : undefined, material: { ...nestedMaterial, color: parsed.color ?? nestedMaterial.color, roughness: parsed.roughness ?? nestedMaterial.roughness, metalness: parsed.metalness ?? nestedMaterial.metalness } });
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
      return { content: [{ type: 'text', text: JSON.stringify(preview) }], structuredContent: preview };
    }, { readOnlyHint: true }),
    tool('apply_scene_transaction', 'Atomically apply 1–20 previously previewable modeling operations as one visible revision and one undo step. Rejects stale expected_revision values and never partially applies.', transactionInputSchema, (input) => {
      const parsed = transactionSchema.extend({ expected_revision: z.number().int().nonnegative() }).parse(input);
      const state = useStudioStore.getState();
      if (state.doc.revision !== parsed.expected_revision) throw new Error(`Scene changed after preview. Expected revision ${parsed.expected_revision}, current revision is ${state.doc.revision}.`);
      const result = state.executeTransaction(parsed.operations.map(operationToCommand), 'agent', parsed.label);
      return response(result.label, result.objectIds);
    }),
    tool('rename_object', 'Rename one scene object. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['object_id', 'name'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_id: objectId, name: z.string().min(1).max(80) }).parse(input); return run({ type: 'rename', objectId: parsed.object_id, name: parsed.name }); }),
    tool('duplicate_object', 'Duplicate an object or group and offset the new copy. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, name: { type: 'string', maxLength: 80 }, offset: vec3Schema }, required: ['object_id'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_id: objectId, name: z.string().max(80).optional(), offset: vec3.optional() }).parse(input); return run({ type: 'duplicate', objectId: parsed.object_id, name: parsed.name, offset: parsed.offset }); }),
    tool('delete_object', 'Delete one object. Deleting a Boolean result restores its source operands. This destructive change is immediate but reversible with undo_scene_change.', {
      type: 'object', properties: { object_id: objectIdSchema }, required: ['object_id'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_id: objectId }).parse(input); return run({ type: 'delete', objectId: parsed.object_id }); }, { readOnlyHint: false, destructiveHint: true }),
    tool('group_objects', 'Create a transformable group from two or more objects that share the same parent. Applies immediately and is reversible.', {
      type: 'object', properties: { object_ids: { type: 'array', items: objectIdSchema, minItems: 2, uniqueItems: true }, name: { type: 'string', maxLength: 80 } }, required: ['object_ids'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_ids: z.array(objectId).min(2), name: z.string().max(80).optional() }).parse(input); return run({ type: 'group', objectIds: parsed.object_ids, name: parsed.name }); }),
    tool('ungroup_object', 'Remove one group while preserving its children and visible world transforms. Applies immediately and is reversible.', {
      type: 'object', properties: { group_id: objectIdSchema }, required: ['group_id'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ group_id: objectId }).parse(input); return run({ type: 'ungroup', groupId: parsed.group_id }); }),
    tool('select_objects', 'Change the current selection so the person can inspect requested objects. This does not change model geometry.', {
      type: 'object', properties: { object_ids: { type: 'array', items: objectIdSchema, uniqueItems: true } }, required: ['object_ids'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_ids: z.array(objectId) }).parse(input); useStudioStore.getState().select(parsed.object_ids, 'agent'); return response(`Selected ${parsed.object_ids.length} object${parsed.object_ids.length === 1 ? '' : 's'}`, parsed.object_ids); }),
    tool('focus_objects', 'Move the viewport camera to frame existing objects. This does not change model geometry.', {
      type: 'object', properties: { object_ids: { type: 'array', items: objectIdSchema, minItems: 1, uniqueItems: true } }, required: ['object_ids'], additionalProperties: false,
    }, (input) => { const parsed = z.object({ object_ids: z.array(objectId).min(1) }).parse(input); useStudioStore.getState().focus(parsed.object_ids, 'agent'); return response('Focused the viewport', parsed.object_ids); }),
    tool('undo_scene_change', 'Undo the most recent reversible modeling change and update the live scene immediately.', emptySchema, () => { if (!useStudioStore.getState().undo('agent')) throw new Error('There is no scene change to undo.'); return response('Undid the most recent scene change'); }),
    tool('redo_scene_change', 'Redo the next modeling change in history and update the live scene immediately.', emptySchema, () => { if (!useStudioStore.getState().redo('agent')) throw new Error('There is no scene change to redo.'); return response('Redid the next scene change'); }),
  ];

  try {
    for (const definition of definitions) await modelContext.registerTool(definition, { signal: controller.signal });
    useStudioStore.getState().setWebMcpStatus('ready');
  } catch (error) {
    controller.abort();
    useStudioStore.getState().setWebMcpStatus('error');
    throw error;
  }
  return () => controller.abort();
}
