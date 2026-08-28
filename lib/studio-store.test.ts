import { beforeEach, describe, expect, it } from 'vitest';

import { validateSceneDocument } from '@/lib/persistence';
import { useStudioStore } from '@/lib/studio-store';
import { createLampStudy } from '@/lib/studio-types';

function resetStore() {
  useStudioStore.setState({
    doc: createLampStudy(),
    selection: ['lamp-shade'],
    history: [],
    future: [],
    activity: [],
    lastAgentChange: null,
    error: null,
  });
}

describe('scene command store', () => {
  beforeEach(resetStore);

  it('adds a primitive and supports undo and redo', () => {
    const before = useStudioStore.getState().doc.objects.length;
    const result = useStudioStore.getState().execute({ type: 'add_primitive', primitiveType: 'box', name: 'Agent block' }, 'agent');
    expect(useStudioStore.getState().doc.objects).toHaveLength(before + 1);
    expect(useStudioStore.getState().lastAgentChange?.objectIds).toEqual(result.objectIds);
    expect(useStudioStore.getState().activity[0].actor).toBe('agent');

    expect(useStudioStore.getState().undo()).toBe(true);
    expect(useStudioStore.getState().doc.objects).toHaveLength(before);
    expect(useStudioStore.getState().redo()).toBe(true);
    expect(useStudioStore.getState().doc.objects).toHaveLength(before + 1);
  });

  it('updates transforms and materials through the same reversible command layer', () => {
    useStudioStore.getState().execute({ type: 'set_transform', objectId: 'lamp-shade', position: [2, 4, 1], rotation: [0, 20, -30], scale: [2, 1.5, 2] });
    useStudioStore.getState().execute({ type: 'set_material', objectId: 'lamp-shade', material: { color: '#3366ff', metalness: 0.4 } });
    const shade = useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-shade');
    expect(shade?.position).toEqual([2, 4, 1]);
    expect(shade?.material.color).toBe('#3366ff');
    expect(shade?.material.metalness).toBe(0.4);
    useStudioStore.getState().undo();
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-shade')?.material.color).toBe('#e9e4d8');
  });

  it('rejects invalid transforms without mutating the scene', () => {
    const revision = useStudioStore.getState().doc.revision;
    expect(() => useStudioStore.getState().execute({ type: 'set_transform', objectId: 'lamp-shade', scale: [1, 0, 1] })).toThrow(/Scale/);
    expect(useStudioStore.getState().doc.revision).toBe(revision);
    expect(useStudioStore.getState().history).toHaveLength(0);
  });

  it('groups and ungroups objects while preserving their visible positions', () => {
    const original = ['lamp-base', 'lamp-lower-arm'].map((id) => useStudioStore.getState().doc.objects.find((object) => object.id === id)!.position);
    const result = useStudioStore.getState().execute({ type: 'group', objectIds: ['lamp-base', 'lamp-lower-arm'], name: 'Base assembly' });
    const groupId = result.objectIds[0];
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === groupId)?.type).toBe('group');
    useStudioStore.getState().execute({ type: 'ungroup', groupId });
    const restored = ['lamp-base', 'lamp-lower-arm'].map((id) => useStudioStore.getState().doc.objects.find((object) => object.id === id)!.position);
    restored.forEach((position, index) => position.forEach((value, axis) => expect(value).toBeCloseTo(original[index][axis], 6)));
  });

  it('validates native project documents and rejects broken hierarchy', () => {
    expect(validateSceneDocument(createLampStudy()).objects).toHaveLength(5);
    const invalid = createLampStudy();
    invalid.objects[0].parentId = 'missing-parent';
    expect(() => validateSceneDocument(invalid)).toThrow(/Parent object/);
  });
});
