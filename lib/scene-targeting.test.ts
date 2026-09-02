import { describe, expect, it } from 'vitest';

import { getObjectWorldBounds } from '@/lib/scene-analysis';
import { dependencyClosure, findSceneObjects, normalizeObjectName, relativePosition, resolveObjectTarget } from '@/lib/scene-targeting';
import { createLampStudy, makeObject } from '@/lib/studio-types';

describe('scene targeting', () => {
  it('normalizes separators and resolves an exact human-readable name', () => {
    const doc = createLampStudy();
    doc.objects.push(makeObject('cylinder', 'Cylinder_L', { id: 'cylinder-l' }));
    expect(normalizeObjectName('  CYLINDER-L ')).toBe('cylinder l');
    expect(resolveObjectTarget(doc, { name: 'Cylinder L' }).id).toBe('cylinder-l');
    expect(findSceneObjects(doc, { query: 'cylinder-l', match: 'normalized_exact' })).toHaveLength(1);
  });

  it('rejects ambiguous normalized names with stable candidate IDs', () => {
    const doc = createLampStudy();
    doc.objects.push(makeObject('sphere', 'Marker_A', { id: 'marker-a' }), makeObject('sphere', 'marker a', { id: 'marker-b' }));
    expect(() => resolveObjectTarget(doc, { name: 'Marker-A' })).toThrow(/marker-a.*marker-b/i);
  });

  it('uses rotated world bounds for relative placement', () => {
    const doc = createLampStudy();
    const target = makeObject('box', 'Rotated target', { id: 'rotated', position: [3, 2, -1], rotation: [0, 0, 45], scale: [2, 1, 1] });
    const sphere = makeObject('sphere', 'Follower', { id: 'follower', position: [0, 0, 0], scale: [0.5, 0.5, 0.5] });
    doc.objects.push(target, sphere);
    const targetBounds = getObjectWorldBounds(doc, target.id)!;
    const sphereBounds = getObjectWorldBounds(doc, sphere.id)!;
    const position = relativePosition(targetBounds, sphereBounds, 'top');
    sphere.position = position;
    const placed = getObjectWorldBounds(doc, sphere.id)!;
    expect(placed.min[1]).toBeCloseTo(targetBounds.max[1], 8);
    expect(position[0]).toBeCloseTo((targetBounds.min[0] + targetBounds.max[0]) / 2, 8);
  });

  it('includes hierarchy and Boolean dependencies in the conflict closure', () => {
    const doc = createLampStudy();
    const group = makeObject('group', 'Assembly', { id: 'assembly' });
    doc.objects.find((object) => object.id === 'lamp-base')!.parentId = group.id;
    const result = makeObject('boolean', 'Result', { id: 'result', boolean: { operation: 'union', operandIds: ['lamp-lower-arm', 'lamp-upper-arm'] } });
    doc.objects.push(group, result);
    const closure = dependencyClosure(doc, ['lamp-base']);
    expect([...closure]).toEqual(expect.arrayContaining(['assembly', 'lamp-base']));
    expect([...dependencyClosure(doc, ['lamp-lower-arm'])]).toEqual(expect.arrayContaining(['lamp-upper-arm', 'result']));
  });
});
