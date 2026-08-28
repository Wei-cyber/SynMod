import { z } from 'zod';

import { getObjectSnapshot, useStudioStore } from '@/lib/studio-store';
import type { SceneCommand, Vec3 } from '@/lib/studio-types';

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const vec3Schema = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
  description: 'Exactly three finite numbers in X, Y, Z order.',
};
const objectIdSchema = { type: 'string', minLength: 1, description: 'Stable object ID from get_scene_summary or get_selection.' };
const primitiveEnum = ['box', 'sphere', 'cylinder', 'cone', 'torus'];
const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const objectId = z.string().min(1);

function response(summary: string, objectIds: string[] = []) {
  const state = useStudioStore.getState();
  const objects = objectIds.map(getObjectSnapshot).filter(Boolean);
  const payload = {
    ok: true,
    summary,
    revision: state.doc.revision,
    affectedObjectIds: objectIds,
    objects,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function run(command: SceneCommand) {
  const result = useStudioStore.getState().execute(command, 'agent');
  return response(result.label, result.objectIds);
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  execute: (input: unknown) => unknown | Promise<unknown>,
  annotations: Record<string, boolean> = { readOnlyHint: false },
) {
  return { name, description, inputSchema, annotations, execute };
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
    tool('get_scene_summary', 'Read the current Model Room project, scene revision, object hierarchy, transforms, and materials. This tool does not change the scene.', emptySchema, () => {
      const state = useStudioStore.getState();
      const payload = { title: state.doc.title, revision: state.doc.revision, objectCount: state.doc.objects.length, selection: state.selection, objects: state.doc.objects };
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
    tool('add_primitive', 'Add one visible primitive to the live scene. The change is applied immediately, highlighted in orange, recorded as Agent activity, autosaved, and can be undone.', {
      type: 'object',
      properties: {
        primitive_type: { type: 'string', enum: primitiveEnum },
        name: { type: 'string', maxLength: 80 },
        position: vec3Schema,
        rotation_degrees: vec3Schema,
        scale: vec3Schema,
        color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
        roughness: { type: 'number', minimum: 0, maximum: 1 },
        metalness: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['primitive_type'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({
        primitive_type: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus']),
        name: z.string().max(80).optional(), position: vec3.optional(), rotation_degrees: vec3.optional(), scale: vec3.optional(),
        color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), roughness: z.number().min(0).max(1).optional(), metalness: z.number().min(0).max(1).optional(),
      }).parse(input);
      return run({
        type: 'add_primitive', primitiveType: parsed.primitive_type, name: parsed.name, position: parsed.position,
        rotation: parsed.rotation_degrees, scale: parsed.scale,
        material: { color: parsed.color, roughness: parsed.roughness, metalness: parsed.metalness },
      });
    }),
    tool('set_object_transform', 'Set position, rotation in degrees, or scale for one scene object. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, position: vec3Schema, rotation_degrees: vec3Schema, scale: vec3Schema }, required: ['object_id'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ object_id: objectId, position: vec3.optional(), rotation_degrees: vec3.optional(), scale: vec3.optional() }).refine((value) => value.position || value.rotation_degrees || value.scale, 'Provide at least one transform property.').parse(input);
      return run({ type: 'set_transform', objectId: parsed.object_id, position: parsed.position, rotation: parsed.rotation_degrees, scale: parsed.scale });
    }),
    tool('set_object_material', 'Change the material of one primitive. Applies immediately and is reversible. Groups and imported GLBs do not expose editable materials in v1.', {
      type: 'object', properties: { object_id: objectIdSchema, color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }, roughness: { type: 'number', minimum: 0, maximum: 1 }, metalness: { type: 'number', minimum: 0, maximum: 1 }, wireframe: { type: 'boolean' } }, required: ['object_id'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ object_id: objectId, color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), roughness: z.number().min(0).max(1).optional(), metalness: z.number().min(0).max(1).optional(), wireframe: z.boolean().optional() }).refine((value) => value.color !== undefined || value.roughness !== undefined || value.metalness !== undefined || value.wireframe !== undefined, 'Provide at least one material property.').parse(input);
      return run({ type: 'set_material', objectId: parsed.object_id, material: { color: parsed.color, roughness: parsed.roughness, metalness: parsed.metalness, wireframe: parsed.wireframe } });
    }),
    tool('rename_object', 'Rename one scene object. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['object_id', 'name'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ object_id: objectId, name: z.string().min(1).max(80) }).parse(input);
      return run({ type: 'rename', objectId: parsed.object_id, name: parsed.name });
    }),
    tool('duplicate_object', 'Duplicate an object or group and offset the new copy. Applies immediately and is reversible.', {
      type: 'object', properties: { object_id: objectIdSchema, name: { type: 'string', maxLength: 80 }, offset: vec3Schema }, required: ['object_id'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ object_id: objectId, name: z.string().max(80).optional(), offset: vec3.optional() }).parse(input);
      return run({ type: 'duplicate', objectId: parsed.object_id, name: parsed.name, offset: parsed.offset });
    }),
    tool('delete_object', 'Delete one object. Deleting a group also deletes its children. This destructive change is immediate but can be restored with undo_scene_change.', {
      type: 'object', properties: { object_id: objectIdSchema }, required: ['object_id'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ object_id: objectId }).parse(input);
      return run({ type: 'delete', objectId: parsed.object_id });
    }, { readOnlyHint: false, destructiveHint: true }),
    tool('group_objects', 'Create a transformable group from two or more objects that share the same parent. Applies immediately and is reversible.', {
      type: 'object', properties: { object_ids: { type: 'array', items: objectIdSchema, minItems: 2, uniqueItems: true }, name: { type: 'string', maxLength: 80 } }, required: ['object_ids'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ object_ids: z.array(objectId).min(2), name: z.string().max(80).optional() }).parse(input);
      return run({ type: 'group', objectIds: parsed.object_ids, name: parsed.name });
    }),
    tool('ungroup_object', 'Remove one group while preserving its children and their visible world transforms. Applies immediately and is reversible.', {
      type: 'object', properties: { group_id: objectIdSchema }, required: ['group_id'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ group_id: objectId }).parse(input);
      return run({ type: 'ungroup', groupId: parsed.group_id });
    }),
    tool('select_objects', 'Change the current scene selection so the person can inspect the requested objects. This does not change model geometry.', {
      type: 'object', properties: { object_ids: { type: 'array', items: objectIdSchema, uniqueItems: true } }, required: ['object_ids'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ object_ids: z.array(objectId) }).parse(input);
      useStudioStore.getState().select(parsed.object_ids, 'agent');
      return response(`Selected ${parsed.object_ids.length} object${parsed.object_ids.length === 1 ? '' : 's'}`, parsed.object_ids);
    }),
    tool('focus_objects', 'Move the live viewport camera to frame one or more existing objects. This does not change model geometry.', {
      type: 'object', properties: { object_ids: { type: 'array', items: objectIdSchema, minItems: 1, uniqueItems: true } }, required: ['object_ids'], additionalProperties: false,
    }, (input) => {
      const parsed = z.object({ object_ids: z.array(objectId).min(1) }).parse(input);
      useStudioStore.getState().focus(parsed.object_ids, 'agent');
      return response('Focused the viewport', parsed.object_ids);
    }),
    tool('undo_scene_change', 'Undo the most recent reversible modeling change and update the live scene immediately.', emptySchema, () => {
      if (!useStudioStore.getState().undo('agent')) throw new Error('There is no scene change to undo.');
      return response('Undid the most recent scene change');
    }),
    tool('redo_scene_change', 'Redo the next modeling change in history and update the live scene immediately.', emptySchema, () => {
      if (!useStudioStore.getState().redo('agent')) throw new Error('There is no scene change to redo.');
      return response('Redid the next scene change');
    }),
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
