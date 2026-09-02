import { beforeEach, describe, expect, it } from 'vitest';

import { validateSceneDocument } from '@/lib/persistence';
import { useStudioStore } from '@/lib/studio-store';
import { createLampStudy, createRoverStudy, migrateUntouchedLampStudy } from '@/lib/studio-types';

function resetStore() {
  useStudioStore.setState({
    doc: createLampStudy(),
    selection: ['lamp-shade'],
    history: [],
    future: [],
    activity: [],
    lastAgentChange: null,
    error: null,
    readOnly: false,
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

  it('provides a complete procedural rover as the default demo', () => {
    const rover = validateSceneDocument(createRoverStudy());
    expect(rover).toMatchObject({ projectId: 'rover-study', title: 'Rover Study' });
    expect(rover.objects).toHaveLength(23);
    expect(rover.objects.find((object) => object.id === 'rover-chassis')?.boolean).toEqual({
      operation: 'subtract',
      operandIds: ['rover-chassis-source', 'rover-front-axle-cutter'],
    });
    expect(rover.objects.find((object) => object.id === 'rover-left-headlight')?.material.emissiveIntensity).toBeGreaterThan(0);
    expect(rover.objects.find((object) => object.id === 'lamp-shade')?.name).toBe('Gripper housing');
    expect(rover.settings).toMatchObject({ environment: 'warehouse', shadows: true });
  });

  it('migrates only an untouched Lamp Study starter to the rover demo', () => {
    const untouched = createLampStudy();
    const migrated = migrateUntouchedLampStudy(untouched);
    expect(migrated.title).toBe('Rover Study');
    expect(migrated.projectId).toBe(untouched.projectId);

    const edited = createLampStudy();
    edited.revision += 1;
    edited.objects[0].position = [4, 0.15, 0];
    expect(migrateUntouchedLampStudy(edited)).toBe(edited);
  });

  it('refines parametric geometry and scene lighting through reversible commands', () => {
    useStudioStore.getState().execute({ type: 'set_geometry', objectId: 'lamp-shade', geometry: { height: 1.8, radialSegments: 48 } });
    useStudioStore.getState().execute({ type: 'set_environment', environment: 'sunset', exposure: 1.35, shadows: false });
    const state = useStudioStore.getState();
    expect(state.doc.objects.find((object) => object.id === 'lamp-shade')?.geometry?.height).toBe(1.8);
    expect(state.doc.settings).toMatchObject({ environment: 'sunset', exposure: 1.35, shadows: false });
    state.undo();
    expect(useStudioStore.getState().doc.settings.environment).toBe('studio');
  });

  it('creates a non-destructive Boolean feature and restores its operands on delete', () => {
    const result = useStudioStore.getState().execute({ type: 'boolean', operation: 'union', operandIds: ['lamp-base', 'lamp-lower-arm'], name: 'Joined base' });
    const feature = useStudioStore.getState().doc.objects.find((object) => object.id === result.objectIds[0]);
    expect(feature?.boolean).toEqual({ operation: 'union', operandIds: ['lamp-base', 'lamp-lower-arm'] });
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-base')?.visible).toBe(false);
    useStudioStore.getState().execute({ type: 'delete', objectId: feature!.id });
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-base')?.visible).toBe(true);
  });

  it('previews without mutation and applies a transaction as one revision and undo step', () => {
    const state = useStudioStore.getState();
    const revision = state.doc.revision;
    const preview = state.previewTransaction([
      { type: 'set_geometry', objectId: 'lamp-shade', geometry: { height: 2 } },
      { type: 'set_material', objectId: 'lamp-shade', material: { color: '#2255aa' } },
    ]);
    expect(preview.revision).toBe(revision);
    expect(useStudioStore.getState().doc.revision).toBe(revision);
    useStudioStore.getState().executeTransaction([
      { type: 'set_geometry', objectId: 'lamp-shade', geometry: { height: 2 } },
      { type: 'set_material', objectId: 'lamp-shade', material: { color: '#2255aa' } },
    ], 'agent', 'Refined lamp shade');
    expect(useStudioStore.getState().doc.revision).toBe(revision + 1);
    expect(useStudioStore.getState().history).toHaveLength(1);
    expect(useStudioStore.getState().activity[0]).toMatchObject({ actor: 'agent', label: 'Refined lamp shade' });
  });
});
