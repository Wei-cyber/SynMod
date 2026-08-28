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
    useStudioStore.setState({ doc: createLampStudy(), selection: [], history: [], future: [], activity: [], webmcpStatus: 'checking' });
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
});
