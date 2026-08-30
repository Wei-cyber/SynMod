import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudioStore } from '@/lib/studio-store';
import { createLampStudy } from '@/lib/studio-types';
import { registerWebMcpTools } from '@/lib/webmcp';

interface CapturedTool {
  name: string;
  annotations?: Record<string, boolean>;
  execute: (input: unknown) => unknown;
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
    expect(tools.find((tool) => tool.name === 'get_scene_summary')?.annotations?.readOnlyHint).toBe(true);
    expect(useStudioStore.getState().webmcpStatus).toBe('ready');
    cleanup();
    expect(signal?.aborted).toBe(true);
  });

  it('applies agent tools through the scene store and returns verifiable state', async () => {
    const tools: CapturedTool[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const add = tools.find((tool) => tool.name === 'add_primitive')!;
    const result = await add.execute({ primitive_type: 'sphere', name: 'Blue marker', position: [1, 2, 3], color: '#3366ff' }) as { structuredContent: { revision: number; affectedObjectIds: string[]; objects: Array<{ name: string }> } };
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
    expect(() => transform.execute({ object_id: 'lamp-shade', scale: [1, -1, 1] })).toThrow();
    expect(useStudioStore.getState().doc.revision).toBe(revision);
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
    const preview = await previewTool.execute({ operations }) as { structuredContent: { revision: number } };
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-shade')?.geometry?.height).toBe(1);
    const result = await applyTool.execute({ expected_revision: preview.structuredContent.revision, label: 'Warm shade refinement', operations }) as { structuredContent: { revision: number } };
    expect(result.structuredContent.revision).toBe(preview.structuredContent.revision + 1);
    expect(useStudioStore.getState().activity[0]).toMatchObject({ actor: 'agent', label: 'Warm shade refinement' });
    expect(() => applyTool.execute({ expected_revision: preview.structuredContent.revision, operations })).toThrow(/Scene changed/);
  });

  it('returns compact texture-safe objects and controls checkpoint history through tools', async () => {
    const tools: CapturedTool[] = [];
    const doc = createLampStudy();
    doc.objects[0].material.baseColorTexture = 'data:image/png;base64,AAAA';
    useStudioStore.setState({ doc, readOnly: false });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: { registerTool: async (definition: CapturedTool) => { tools.push(definition); } } } });
    await registerWebMcpTools();
    const summary = await tools.find((tool) => tool.name === 'get_scene_summary')!.execute({}) as { structuredContent: unknown };
    expect(JSON.stringify(summary.structuredContent)).not.toContain('data:image');
    const created = await tools.find((tool) => tool.name === 'create_checkpoint')!.execute({ name: 'Agent checkpoint' }) as { structuredContent: { checkpoints: Array<{ name: string }> } };
    expect(created.structuredContent.checkpoints[0].name).toBe('Agent checkpoint');
    expect(useStudioStore.getState().activity[0].actor).toBe('agent');
  });
});
