import { beforeEach, describe, expect, it } from 'vitest';

import { analyzeScene, buildFeatureTree, compactObjectSnapshot, compareCheckpoint } from '@/lib/scene-analysis';
import { validateSceneDocument } from '@/lib/persistence';
import { decodeShareDocument, encodeShareDocument, makeEditableCopy } from '@/lib/share-links';
import { useStudioStore } from '@/lib/studio-store';
import { createLampStudy } from '@/lib/studio-types';

function resetStore() {
  useStudioStore.setState({
    doc: createLampStudy(), selection: ['lamp-shade'], history: [], future: [], activity: [],
    lastAgentChange: null, error: null, readOnly: false,
  });
}

describe('P1 project history and intelligence', () => {
  beforeEach(resetStore);

  it('migrates version 2 documents into versioned procedural projects', () => {
    const current = createLampStudy();
    const { features: _features, checkpoints: _checkpoints, ...versionTwo } = current;
    const migrated = validateSceneDocument({ ...versionTwo, schemaVersion: 2 });
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.features[0]).toMatchObject({ kind: 'source', revision: current.revision });
    expect(migrated.checkpoints).toEqual([]);
  });

  it('creates, compares, restores, and undoes a checkpoint through the command layer', () => {
    useStudioStore.getState().execute({ type: 'create_checkpoint', name: 'Before shade edit' });
    const checkpoint = useStudioStore.getState().doc.checkpoints[0];
    useStudioStore.getState().execute({ type: 'set_transform', objectId: 'lamp-shade', position: [5, 4, 0] });
    const comparison = compareCheckpoint(useStudioStore.getState().doc, checkpoint);
    expect(comparison.changedObjectIds).toContain('lamp-shade');
    useStudioStore.getState().execute({ type: 'restore_checkpoint', checkpointId: checkpoint.id });
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-shade')?.position).toEqual([1.55, 4.3, 0]);
    expect(useStudioStore.getState().undo()).toBe(true);
    expect(useStudioStore.getState().doc.objects.find((object) => object.id === 'lamp-shade')?.position).toEqual([5, 4, 0]);
  });

  it('branches and duplicates without changing the source identity', () => {
    const sourceId = useStudioStore.getState().doc.projectId;
    useStudioStore.getState().execute({ type: 'duplicate_project', name: 'Lamp variant' });
    const duplicate = useStudioStore.getState().doc;
    expect(duplicate.projectId).not.toBe(sourceId);
    expect(duplicate.branch?.parentProjectId).toBe(sourceId);
    expect(duplicate.title).toBe('Lamp variant');
  });

  it('builds a procedural tree and reports bounds, triangles, and intersections', () => {
    useStudioStore.getState().execute({ type: 'set_material', objectId: 'lamp-shade', material: { color: '#cc5500' } }, 'agent');
    const doc = useStudioStore.getState().doc;
    const tree = buildFeatureTree(doc);
    const shade = tree.find((node) => node.id === 'lamp-shade');
    expect(shade?.children?.some((node) => node.kind === 'material')).toBe(true);
    const report = analyzeScene(doc);
    expect(report.totalTriangleCount).toBeGreaterThan(0);
    expect(report.objects.find((object) => object.objectId === 'lamp-shade')?.bounds).not.toBeNull();
    expect(Array.isArray(report.intersections)).toBe(true);
  });

  it('keeps embedded binary data out of compact agent results', () => {
    const doc = createLampStudy();
    doc.objects[0].material.baseColorTexture = 'data:image/png;base64,AAAA';
    const compact = compactObjectSnapshot(doc.objects[0]);
    expect(JSON.stringify(compact)).not.toContain('data:image');
    expect(compact).toHaveProperty('textures.baseColorTexture.embedded', true);
  });
});

describe('browser-only sharing', () => {
  it('round-trips a validated document and omits private checkpoint history', async () => {
    const doc = createLampStudy();
    useStudioStore.setState({ doc, readOnly: false });
    useStudioStore.getState().execute({ type: 'create_checkpoint', name: 'Private checkpoint' });
    const encoded = await encodeShareDocument(useStudioStore.getState().doc);
    const decoded = await decodeShareDocument(encoded);
    expect(decoded.objects).toHaveLength(doc.objects.length);
    expect(decoded.checkpoints).toEqual([]);
  });

  it('creates an independent editable copy and rejects corrupt payloads', async () => {
    const doc = createLampStudy();
    const copy = makeEditableCopy(doc);
    expect(copy.projectId).not.toBe(doc.projectId);
    expect(copy.branch?.parentProjectId).toBe(doc.projectId);
    await expect(decodeShareDocument('definitely-not-a-valid-project')).rejects.toThrow(/corrupt|unsupported/i);
  });
});
