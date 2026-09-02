import { getObjectWorldBounds, type WorldBounds } from '@/lib/scene-analysis';
import type { ObjectType, SceneDocument, StudioObject, Vec3 } from '@/lib/studio-types';

export interface ObjectTarget {
  objectId?: string;
  name?: string;
  tempRef?: string;
}

export type RelativePlacement = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back' | 'center';

export function normalizeObjectName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, ' ');
}

export function resolveObjectTarget(doc: SceneDocument, target: ObjectTarget, temporaryIds = new Map<string, string>()) {
  const fields = [target.objectId, target.name, target.tempRef].filter((value) => value !== undefined);
  if (fields.length !== 1) throw new Error('An object target must provide exactly one of object_id, name, or temp_ref.');
  if (target.tempRef) {
    const id = temporaryIds.get(target.tempRef);
    if (!id) throw new Error(`Temporary object reference not found: ${target.tempRef}`);
    const object = doc.objects.find((item) => item.id === id);
    if (!object) throw new Error(`Temporary object no longer exists: ${target.tempRef}`);
    return object;
  }
  if (target.objectId) {
    const object = doc.objects.find((item) => item.id === target.objectId);
    if (!object) throw new Error(`Object not found: ${target.objectId}`);
    return object;
  }
  const normalized = normalizeObjectName(target.name!);
  const matches = doc.objects.filter((item) => normalizeObjectName(item.name) === normalized);
  if (!matches.length) throw new Error(`Object not found by name: ${target.name}`);
  if (matches.length > 1) {
    const candidates = matches.map((item) => `${item.name} (${item.id})`).join(', ');
    throw new Error(`Object name is ambiguous: ${target.name}. Candidates: ${candidates}`);
  }
  return matches[0];
}

export function findSceneObjects(doc: SceneDocument, options: {
  query?: string;
  match?: 'normalized_exact' | 'contains';
  types?: ObjectType[];
  visible?: boolean;
  parentId?: string | null;
  selectedIds?: string[];
  selectionOnly?: boolean;
  limit?: number;
}) {
  const query = options.query ? normalizeObjectName(options.query) : undefined;
  const selected = new Set(options.selectedIds ?? []);
  return doc.objects.filter((object) => {
    const name = normalizeObjectName(object.name);
    if (query && (options.match === 'contains' ? !name.includes(query) : name !== query)) return false;
    if (options.types?.length && !options.types.includes(object.type)) return false;
    if (options.visible !== undefined && object.visible !== options.visible) return false;
    if (options.parentId !== undefined && object.parentId !== options.parentId) return false;
    if (options.selectionOnly && !selected.has(object.id)) return false;
    return true;
  }).slice(0, options.limit ?? 20);
}

export function objectIndexEntry(doc: SceneDocument, object: StudioObject) {
  return {
    id: object.id,
    name: object.name,
    type: object.type,
    parentId: object.parentId,
    visible: object.visible,
    position: object.position,
    rotation: object.rotation,
    scale: object.scale,
    worldBounds: getObjectWorldBounds(doc, object.id),
  };
}

function center(bounds: WorldBounds): Vec3 {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

export function relativePosition(targetBounds: WorldBounds, objectBounds: WorldBounds, placement: RelativePlacement, gap = 0): Vec3 {
  if (!Number.isFinite(gap) || Math.abs(gap) > 1000) throw new Error('Relative placement gap must be finite and no more than 1000 units.');
  const targetCenter = center(targetBounds);
  const half: Vec3 = [objectBounds.size[0] / 2, objectBounds.size[1] / 2, objectBounds.size[2] / 2];
  switch (placement) {
    case 'top': return [targetCenter[0], targetBounds.max[1] + gap + half[1], targetCenter[2]];
    case 'bottom': return [targetCenter[0], targetBounds.min[1] - gap - half[1], targetCenter[2]];
    case 'left': return [targetBounds.min[0] - gap - half[0], targetCenter[1], targetCenter[2]];
    case 'right': return [targetBounds.max[0] + gap + half[0], targetCenter[1], targetCenter[2]];
    case 'front': return [targetCenter[0], targetCenter[1], targetBounds.min[2] - gap - half[2]];
    case 'back': return [targetCenter[0], targetCenter[1], targetBounds.max[2] + gap + half[2]];
    case 'center': return targetCenter;
  }
}

export function dependencyClosure(doc: SceneDocument, seedIds: Iterable<string>) {
  const ids = new Set(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of doc.objects) {
      const related = Boolean(
        ids.has(object.id)
        || (object.parentId && ids.has(object.parentId))
        || (object.parentId && ids.has(object.id) && ids.has(object.parentId))
        || object.boolean?.operandIds.some((id) => ids.has(id))
        || (ids.has(object.id) && object.boolean?.operandIds.length),
      );
      if (!related) continue;
      const candidates = [object.id, object.parentId, ...(object.boolean?.operandIds ?? [])].filter(Boolean) as string[];
      for (const id of candidates) {
        if (!ids.has(id)) {
          ids.add(id);
          changed = true;
        }
      }
      for (const child of doc.objects.filter((item) => item.parentId === object.id)) {
        if (!ids.has(child.id)) {
          ids.add(child.id);
          changed = true;
        }
      }
      for (const result of doc.objects.filter((item) => item.boolean?.operandIds.includes(object.id))) {
        if (!ids.has(result.id)) {
          ids.add(result.id);
          changed = true;
        }
      }
    }
  }
  return ids;
}
