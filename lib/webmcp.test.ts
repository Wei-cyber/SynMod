import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudioStore } from '@/lib/studio-store';
import { createLampStudy } from '@/lib/studio-types';
import { registerWebMcpTools } from '@/lib/webmcp';

interface CapturedTool {
  name: string;
  title?: string;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: object, options: { signal: AbortSignal }) => Promise<unknown>;
}

function executeTool<T = unknown>(tool: CapturedTool, input: object, signal = new AbortController().signal) {
  return tool.execute(input, { signal }) as Promise<T>;
}

describe('WebMCP tools', () => {
  beforeEach(() => {
    useStudioStore.setState({ doc: createLampStudy(), selection: [], history: [], future: [], activity: [], webmcpStatus: 'checking', readOnly: false });
  });

  it('registers the complete tool surface and unregisters through AbortSignal', async () => {
    const tools: CapturedTool[] = [];
    let signal: AbortSignal | undefined;
    const registerTool = vi.fn(async (definition: CapturedTool, options?: { signal?: AbortSignal }) => {
      tools.push(definition);
      signal = options?.signal;
    });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool } } });
    const cleanup = await registerWebMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'get_scene_summary', 'get_object', 'get_selection', 'add_primitive', 'set_object_transform',
      'set_object_material', 'rename_object', 'duplicate_object', 'delete_object', 'group_objects',
      'ungroup_object', 'select_objects', 'focus_objects', 'undo_scene_change', 'redo_scene_change',
      'set_geometry_parameters', 'boolean_objects', 'set_scene_environment', 'inspect_scene_health',
      'preview_scene_transaction', 'apply_scene_transaction',
      'get_feature_tree', 'get_project_versions', 'compare_checkpoint', 'create_checkpoint',
      'restore_checkpoint', 'branch_project', 'duplicate_project', 'create_readonly_share_link',
    ]));
    expect(tools).toHaveLength(29);
    expect(tools.every((tool) => Boolean(tool.title?.trim()))).toBe(true);
    expect(tools.every((tool) => Object.keys(tool.annotations ?? {}).sort().join(',') === 'readOnlyHint,untrustedContentHint')).toBe(true);
    expect(tools.every((tool) => tool.annotations?.untrustedContentHint === true)).toBe(true);
    expect(tools.find((tool) => tool.name === 'get_scene_summary')).toMatchObject({
      title: 'Get Scene Summary',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    });
    expect(useStudioStore.getState().webmcpStatus).toBe('ready');
    cleanup();
    expect(signal?.aborted).toBe(true);
  });

  it('applies agent tools through the scene store and returns verifiable state', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const add = tools.find((tool) => tool.name === 'add_primitive')!;
    const result = await executeTool<{ structuredContent: { revision: number; affectedObjectIds: string[]; objects: Array<{ name: string }> } }>(add, { primitive_type: 'sphere', name: 'Blue marker', position: [1, 2, 3], color: '#3366ff' });
    expect(result.structuredContent.affectedObjectIds).toHaveLength(1);
    expect(result.structuredContent.objects[0].name).toBe('Blue marker');
    expect(useStudioStore.getState().activity[0].actor).toBe('agent');
    expect(useStudioStore.getState().doc.revision).toBe(result.structuredContent.revision);
  });

  it('rejects bad tool input without changing the scene', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const revision = useStudioStore.getState().doc.revision;
    const transform = tools.find((tool) => tool.name === 'set_object_transform')!;
    await expect(executeTool(transform, { object_id: 'lamp-shade', scale: [1, -1, 1] })).rejects.toThrow();
    expect(useStudioStore.getState().doc.revision).toBe(revision);
    const select = tools.find((tool) => tool.name === 'select_objects')!;
    await expect(executeTool(select, { object_ids: ['missing-object'] })).rejects.toThrow(/not found/);
    expect(useStudioStore.getState().selection).toEqual([]);
  });

  it('previews and applies an atomic agent transaction with revision protection', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const previewTool = tools.find((tool) => tool.name === 'preview_scene_transaction')!;
    const applyTool = tools.find((tool) => tool.name === 'apply_scene_transaction')!;
    const operations = [
      { action: 'set_geometry', object_id: 'lamp-shade', geometry: { height: 1.7 } },
      { action: 'set_material', object_id: 'lamp-shade', material: { color: '#cc5500' } },
    ];
    const preview = await executeTool<{ structuredContent: { revision: number } }>(previewTool, { operations });
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-shade')?.geometry?.height).toBe(1);
    const result = await executeTool<{ structuredContent: { revision: number } }>(applyTool, { expected_revision: preview.structuredContent.revision, label: 'Warm shade refinement', operations });
    expect(result.structuredContent.revision).toBe(preview.structuredContent.revision + 1);
    expect(useStudioStore.getState().activity[0]).toMatchObject({ actor: 'agent', label: 'Warm shade refinement' });
    await expect(executeTool(applyTool, { expected_revision: preview.structuredContent.revision, operations })).rejects.toThrow(/Scene changed/);
  });

  it('returns compact texture-safe objects and controls checkpoint history through tools', async () => {
    const tools: CapturedTool[] = [];
    const doc = createLampStudy();
    doc.objects[0].material.baseColorTexture = 'data:image/png;base64,AAAA';
    useStudioStore.setState({ doc, readOnly: false });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const summary = await executeTool<{ structuredContent: unknown }>(tools.find((tool) => tool.name === 'get_scene_summary')!, {});
    expect(JSON.stringify(summary.structuredContent)).not.toContain('data:image');
    const created = await executeTool<{ structuredContent: { checkpoints: Array<{ name: string }> } }>(tools.find((tool) => tool.name === 'create_checkpoint')!, { name: 'Agent checkpoint' });
    expect(created.structuredContent.checkpoints[0].name).toBe('Agent checkpoint');
    expect(useStudioStore.getState().activity[0].actor).toBe('agent');
  });

  it('honors execution cancellation before reads or mutations begin', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const controller = new AbortController();
    controller.abort(new DOMException('Stopped by caller', 'AbortError'));
    const revision = useStudioStore.getState().doc.revision;
    await expect(executeTool(tools.find((tool) => tool.name === 'get_scene_summary')!, {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(executeTool(tools.find((tool) => tool.name === 'add_primitive')!, { primitive_type: 'box' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(useStudioStore.getState().doc.revision).toBe(revision);
  });

  it('requires a current revision for destructive and history tools', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const revision = useStudioStore.getState().doc.revision;
    const deleteTool = tools.find((tool) => tool.name === 'delete_object')!;
    await expect(executeTool(deleteTool, { object_id: 'lamp-base', expected_revision: revision - 1 })).rejects.toThrow(/revision mismatch/);
    expect(useStudioStore.getState().doc.objects).toHaveLength(5);
    const deleted = await executeTool<{ structuredContent: { revision: number } }>(deleteTool, { object_id: 'lamp-base', expected_revision: revision });
    expect(deleted.structuredContent.revision).toBe(revision + 1);
    await executeTool(tools.find((tool) => tool.name === 'undo_scene_change')!, { expected_revision: revision + 1 });
    expect(useStudioStore.getState().doc.objects).toHaveLength(5);
  });
});
