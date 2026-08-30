import { describe, expect, it } from 'vitest';

import { evaluateBooleanGeometry } from '@/lib/manifold-geometry';
import { applySceneCommand } from '@/lib/studio-store';
import { createLampStudy } from '@/lib/studio-types';

describe('Manifold Boolean geometry', () => {
  it('evaluates a watertight Boolean result into renderable triangles', async () => {
    const doc = createLampStudy();
    const result = applySceneCommand(doc, { type: 'boolean', operation: 'union', operandIds: ['lamp-base', 'lamp-lower-arm'] });
    const object = doc.objects.find((candidate) => candidate.id === result.objectIds[0])!;
    const geometry = await evaluateBooleanGeometry(object, doc.objects);
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(geometry.getIndex()?.count).toBeGreaterThan(0);
    geometry.dispose();
  });
});
