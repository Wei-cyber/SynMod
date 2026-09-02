import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudioStore } from '@/lib/studio-store';
import { createLampStudy, makeObject } from '@/lib/studio-types';
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
    useStudioStore.setState({ doc: createLampStudy(), selection: [], history: [], future: [], activity: [], webmcpStatus: 'checking', readOnly: false, agentTask: { token: 'idle', title: 'Agent ready', status: 'idle', startedAt: 0, affectedObjectIds: [] }, agentTaskAbort: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      'preview_scene_transaction', 'apply_scene_transaction', 'execute_scene_transaction', 'find_objects',
      'get_feature_tree', 'get_project_versions', 'compare_checkpoint', 'create_checkpoint',
      'restore_checkpoint', 'branch_project', 'duplicate_project', 'create_readonly_share_link',
    ]));
    expect(tools).toHaveLength(31);
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

  it('starts every tool registration concurrently before waiting for completion', async () => {
    const releases: Array<() => void> = [];
    const registerTool = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool } } });
    const registration = registerWebMcpTools();
    expect(registerTool).toHaveBeenCalledTimes(31);
    releases.forEach((release) => release());
    await registration;
    expect(useStudioStore.getState().webmcpStatus).toBe('ready');
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

  it('finds normalized names and adds a relatively placed primitive in one mutation call', async () => {
    const tools: CapturedTool[] = [];
    const doc = createLampStudy();
    doc.objects.push({ ...doc.objects[0], id: 'cylinder-l', name: 'Cylinder_L', position: [5.5, 2, -7], scale: [1, 1, 1], geometry: { ...doc.objects[0].geometry!, height: 2 }, material: { ...doc.objects[0].material, color: '#335577', roughness: 0.3, metalness: 0.7 } });
    useStudioStore.setState({ doc });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const found = await executeTool<{ structuredContent: { objects: Array<{ id: string; worldBounds: { max: [number, number, number] } }> } }>(tools.find((tool) => tool.name === 'find_objects')!, { query: 'cylinder l' });
    expect(found.structuredContent.objects).toHaveLength(1);
    expect(found.structuredContent.objects[0].id).toBe('cylinder-l');
    const revision = useStudioStore.getState().doc.revision;
    const added = await executeTool<{ structuredContent: { revision: number; objects: Array<{ position: [number, number, number]; material: { color: string } }> } }>(tools.find((tool) => tool.name === 'add_primitive')!, {
      primitive_type: 'cone', name: 'Cone on Cylinder L', relative_to: { target: { name: 'Cylinder L' }, placement: 'top', inherit_material: true },
    });
    expect(added.structuredContent.revision).toBe(revision + 1);
    expect(added.structuredContent.objects[0].position).toEqual([5.5, 3.5, -7]);
    expect(added.structuredContent.objects[0].material.color).toBe('#335577');
  });

  it('executes temporary-reference transactions as one revision and one undo step', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const revision = useStudioStore.getState().doc.revision;
    const historyLength = useStudioStore.getState().history.length;
    const result = await executeTool<{ structuredContent: { revision: number; resolvedRefs: Record<string, string>; affectedObjectIds: string[] } }>(tools.find((tool) => tool.name === 'execute_scene_transaction')!, {
      expected_revision: revision,
      label: 'Fast Boolean assembly',
      operations: [
        { action: 'add_primitive', primitive_type: 'box', name: 'Fast base', result_ref: 'base' },
        { action: 'add_primitive', primitive_type: 'cylinder', name: 'Fast cutter', result_ref: 'cutter' },
        { action: 'boolean', operation: 'subtract', operands: [{ temp_ref: 'base' }, { temp_ref: 'cutter' }], name: 'Fast result', result_ref: 'result' },
        { action: 'set_material', target: { temp_ref: 'result' }, material: { color: '#f15722' } },
      ],
      select_after: [{ temp_ref: 'result' }],
      focus_after: [{ temp_ref: 'result' }],
    });
    expect(result.structuredContent.revision).toBe(revision + 1);
    expect(useStudioStore.getState().history).toHaveLength(historyLength + 1);
    expect(useStudioStore.getState().selection).toEqual([result.structuredContent.resolvedRefs.result]);
    expect(useStudioStore.getState().focusRequest?.objectIds).toEqual([result.structuredContent.resolvedRefs.result]);
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === result.structuredContent.resolvedRefs.result)).toMatchObject({ type: 'boolean', material: { color: '#f15722' } });
    useStudioStore.getState().undo('agent');
    expect(useStudioStore.getState().doc.objects.some((object) => object.name === 'Fast result')).toBe(false);
  });

  it('rebases disjoint human edits and rejects target conflicts', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const executeFast = tools.find((tool) => tool.name === 'execute_scene_transaction')!;
    const firstRevision = useStudioStore.getState().doc.revision;
    useStudioStore.getState().execute({ type: 'set_transform', objectId: 'lamp-base', position: [2, 0.15, 0] }, 'human');
    const rebased = await executeTool<{ structuredContent: { rebasedFromRevision: number; revision: number } }>(executeFast, {
      expected_revision: firstRevision,
      operations: [{ action: 'set_material', target: { object_id: 'lamp-shade' }, material: { color: '#abcdef' } }],
    });
    expect(rebased.structuredContent.rebasedFromRevision).toBe(firstRevision);
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-shade')?.material.color).toBe('#abcdef');
    const conflictRevision = useStudioStore.getState().doc.revision;
    useStudioStore.getState().execute({ type: 'set_transform', objectId: 'lamp-shade', position: [4, 4, 0] }, 'human');
    await expect(executeTool(executeFast, {
      expected_revision: conflictRevision,
      operations: [{ action: 'set_material', target: { object_id: 'lamp-shade' }, material: { color: '#123456' } }],
    })).rejects.toMatchObject({ name: 'SceneConflictError', conflictingObjectIds: ['lamp-shade'] });
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-shade')?.material.color).toBe('#abcdef');
    expect(useStudioStore.getState().agentTask.status).toBe('conflict');
  });

  it('rejects an invalid transaction without partial mutation', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const before = structuredClone(useStudioStore.getState().doc);
    await expect(executeTool(tools.find((tool) => tool.name === 'execute_scene_transaction')!, {
      operations: [
        { action: 'add_primitive', primitive_type: 'sphere', name: 'Must not remain', result_ref: 'new' },
        { action: 'set_material', target: { object_id: 'missing-object' }, material: { color: '#ffffff' } },
      ],
    })).rejects.toThrow(/not found/);
    expect(useStudioStore.getState().doc).toEqual(before);
    expect(useStudioStore.getState().agentTask.status).toBe('failed');
  });

  it('lets the in-app cancel action abort asynchronous execution before commit', async () => {
    const tools: CapturedTool[] = [];
    vi.stubGlobal('window', { confirm: () => true, location: { origin: 'https://synmod.test', pathname: '/' } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const revision = useStudioStore.getState().doc.revision;
    const pending = executeTool(tools.find((tool) => tool.name === 'create_readonly_share_link')!, {});
    expect(useStudioStore.getState().agentTask.status).toBe('running');
    useStudioStore.getState().cancelAgentTask();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(useStudioStore.getState().agentTask.status).toBe('cancelled');
    expect(useStudioStore.getState().doc.revision).toBe(revision);
  });

  it('reports applied when cancellation arrives after a synchronous commit', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const revision = useStudioStore.getState().doc.revision;
    const pending = executeTool(tools.find((tool) => tool.name === 'add_primitive')!, { primitive_type: 'box', name: 'Committed box' });
    useStudioStore.getState().cancelAgentTask();
    await expect(pending).resolves.toMatchObject({ structuredContent: { revision: revision + 1 } });
    expect(useStudioStore.getState().agentTask.status).toBe('applied');
  });

  it('keeps a 50-operation safe transaction under the app-layer latency budget for a 100-object scene', async () => {
    const tools: CapturedTool[] = [];
    const doc = createLampStudy();
    doc.objects.push(...Array.from({ length: 95 }, (_, index) => makeObject('box', `Load ${index}`, { id: `load-${index}`, position: [index % 10, 0.5, Math.floor(index / 10)] })));
    useStudioStore.setState({ doc });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const startedAt = performance.now();
    await executeTool(tools.find((tool) => tool.name === 'execute_scene_transaction')!, {
      operations: Array.from({ length: 50 }, (_, index) => ({ action: 'add_primitive', primitive_type: 'sphere', name: `Fast ${index}` })),
    });
    expect(performance.now() - startedAt).toBeLessThan(100);
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
