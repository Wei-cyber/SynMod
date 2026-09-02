import { Box3, Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';

import { isPrimitiveType, type SceneCheckpoint, type SceneDocument, type StudioObject, type Vec3 } from '@/lib/studio-types';

export interface FeatureTreeNode {
  id: string;
  label: string;
  kind: string;
  objectId?: string;
  revision?: number;
  children?: FeatureTreeNode[];
}

export interface SceneWarning {
  code: 'hidden_inputs' | 'object_budget' | 'triangle_budget' | 'large_scale' | 'oversized_texture' | 'texture_budget' | 'intersection' | 'non_manifold' | 'missing_material' | 'unknown_bounds';
  severity: 'info' | 'warning' | 'error';
  message: string;
  objectIds: string[];
}

function matrixFor(object: StudioObject) {
  return new Matrix4().compose(
    new Vector3(...object.position),
    new Quaternion().setFromEuler(new Euler(...object.rotation.map(MathUtils.degToRad) as Vec3)),
    new Vector3(...object.scale),
  );
}

function worldMatrix(doc: SceneDocument, object: StudioObject, cache: Map<string, Matrix4>): Matrix4 {
  const cached = cache.get(object.id);
  if (cached) return cached;
  const local = matrixFor(object);
  const parent = object.parentId ? doc.objects.find((item) => item.id === object.parentId) : undefined;
  const world = parent ? worldMatrix(doc, parent, cache).clone().multiply(local) : local;
  cache.set(object.id, world);
  return world;
}

function primitiveLocalBounds(object: StudioObject) {
  const geometry = object.geometry;
  if (!geometry || !isPrimitiveType(object.type)) return null;
  switch (object.type) {
    case 'box': return new Box3(new Vector3(-geometry.width / 2, -geometry.height / 2, -geometry.depth / 2), new Vector3(geometry.width / 2, geometry.height / 2, geometry.depth / 2));
    case 'sphere': return new Box3(new Vector3(-geometry.radius, -geometry.radius, -geometry.radius), new Vector3(geometry.radius, geometry.radius, geometry.radius));
    case 'cylinder':
    case 'cone': {
      const radius = Math.max(geometry.radiusTop, geometry.radiusBottom);
      return new Box3(new Vector3(-radius, -geometry.height / 2, -radius), new Vector3(radius, geometry.height / 2, radius));
    }
    case 'torus': {
      const radius = geometry.radius + geometry.tube;
      return new Box3(new Vector3(-radius, -geometry.tube, -radius), new Vector3(radius, geometry.tube, radius));
    }
  }
}

function estimatePrimitiveTriangles(object: StudioObject | undefined) {
  if (!object) return 0;
  const geometry = object.geometry;
  if (!geometry || !isPrimitiveType(object.type)) return 0;
  switch (object.type) {
    case 'box': return 12;
    case 'sphere': return geometry.radialSegments * Math.max(8, Math.floor(geometry.radialSegments * 0.75)) * 2;
    case 'cylinder': return geometry.radialSegments * geometry.heightSegments * 2 + geometry.radialSegments * 2;
    case 'cone': return geometry.radialSegments * geometry.heightSegments * 2 + geometry.radialSegments;
    case 'torus': return geometry.radialSegments * Math.max(8, Math.floor(geometry.radialSegments / 2)) * 2;
  }
}

function objectBox(doc: SceneDocument, object: StudioObject, worldCache: Map<string, Matrix4>, boxCache: Map<string, Box3 | null>): Box3 | null {
  if (boxCache.has(object.id)) return boxCache.get(object.id) ?? null;
  let box: Box3 | null = null;
  const local = primitiveLocalBounds(object);
  if (local) box = local.applyMatrix4(worldMatrix(doc, object, worldCache));
  else if (object.type === 'boolean' && object.boolean) {
    const operandBoxes = object.boolean.operandIds.map((id) => doc.objects.find((item) => item.id === id)).map((operand) => operand ? objectBox(doc, operand, worldCache, boxCache) : null);
    if (operandBoxes[0] && operandBoxes[1]) {
      box = operandBoxes[0].clone();
      if (object.boolean.operation === 'intersect') box.intersect(operandBoxes[1]);
      else if (object.boolean.operation === 'union') box.union(operandBoxes[1]);
    }
  } else if (object.type === 'group' || object.type === 'glb') {
    const childBoxes = doc.objects.filter((item) => item.parentId === object.id).map((child) => objectBox(doc, child, worldCache, boxCache)).filter(Boolean) as Box3[];
    if (childBoxes.length) {
      box = childBoxes[0].clone();
      childBoxes.slice(1).forEach((childBox) => box!.union(childBox));
    }
  }
  if (box?.isEmpty()) box = null;
  boxCache.set(object.id, box);
  return box;
}

function dataUrlBytes(value?: string) {
  if (!value) return 0;
  const comma = value.indexOf(',');
  return comma < 0 ? value.length : Math.floor((value.length - comma - 1) * 0.75);
}

function boxPayload(box: Box3 | null) {
  if (!box) return null;
  return { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3, size: box.getSize(new Vector3()).toArray() as Vec3 };
}

export type WorldBounds = NonNullable<ReturnType<typeof boxPayload>>;

export function getObjectWorldBounds(doc: SceneDocument, objectId: string): WorldBounds | null {
  const object = doc.objects.find((item) => item.id === objectId);
  if (!object) return null;
  return boxPayload(objectBox(doc, object, new Map(), new Map()));
}

export function buildFeatureTree(doc: SceneDocument): FeatureTreeNode[] {
  const recordsByObject = new Map<string, typeof doc.features>();
  for (const record of doc.features) {
    for (const objectId of record.objectIds) recordsByObject.set(objectId, [...(recordsByObject.get(objectId) ?? []), record]);
  }
  const makeNode = (object: StudioObject): FeatureTreeNode => {
    const featureNodes: FeatureTreeNode[] = (recordsByObject.get(object.id) ?? []).map((record) => ({
      id: record.id, label: record.label, kind: record.kind, revision: record.revision,
    }));
    if (!featureNodes.length) featureNodes.push({ id: `${object.id}-source`, label: object.type === 'glb_node' ? 'Imported node' : `${object.type} source`, kind: 'source' });
    if (object.geometry) featureNodes.push({ id: `${object.id}-geometry`, label: 'Parametric geometry', kind: 'geometry' });
    featureNodes.push({ id: `${object.id}-transform`, label: 'Transform', kind: 'transform' });
    if (object.type !== 'group' && object.type !== 'glb') featureNodes.push({ id: `${object.id}-material`, label: 'PBR material', kind: 'material' });
    if (object.boolean) featureNodes.push({ id: `${object.id}-boolean`, label: `${object.boolean.operation} · ${object.boolean.operandIds.join(' + ')}`, kind: 'boolean' });
    const children = doc.objects.filter((item) => item.parentId === object.id).map(makeNode);
    return { id: object.id, label: object.name, kind: object.type, objectId: object.id, children: [...featureNodes, ...children] };
  };
  return doc.objects.filter((object) => !object.parentId).map(makeNode);
}

export function compareCheckpoint(doc: SceneDocument, checkpoint: SceneCheckpoint) {
  const currentById = new Map(doc.objects.map((object) => [object.id, object]));
  const savedById = new Map(checkpoint.snapshot.objects.map((object) => [object.id, object]));
  const addedObjectIds = doc.objects.filter((object) => !savedById.has(object.id)).map((object) => object.id);
  const removedObjectIds = checkpoint.snapshot.objects.filter((object) => !currentById.has(object.id)).map((object) => object.id);
  const changedObjectIds = doc.objects.filter((object) => {
    const saved = savedById.get(object.id);
    return saved ? JSON.stringify(object) !== JSON.stringify(saved) : false;
  }).map((object) => object.id);
  const settingsChanged = JSON.stringify(doc.settings) !== JSON.stringify(checkpoint.snapshot.settings);
  return {
    checkpointId: checkpoint.id,
    checkpointName: checkpoint.name,
    checkpointRevision: checkpoint.sourceRevision,
    currentRevision: doc.revision,
    addedObjectIds,
    removedObjectIds,
    changedObjectIds,
    settingsChanged,
    summary: `${addedObjectIds.length} added, ${removedObjectIds.length} removed, ${changedObjectIds.length} changed${settingsChanged ? ', scene settings changed' : ''}`,
  };
}

export function analyzeScene(doc: SceneDocument) {
  const warnings: SceneWarning[] = [];
  const worldCache = new Map<string, Matrix4>();
  const boxCache = new Map<string, Box3 | null>();
  const hiddenObjectCount = doc.objects.filter((object) => !object.visible).length;
  const objectMetrics = doc.objects.map((object) => {
    let triangleCount = object.triangleCount ?? estimatePrimitiveTriangles(object);
    if (object.type === 'boolean' && object.boolean) triangleCount = object.boolean.operandIds.reduce((sum, id) => {
      const operand = doc.objects.find((item) => item.id === id);
      return sum + (operand?.triangleCount ?? estimatePrimitiveTriangles(operand));
    }, 0);
    const textureBytes = dataUrlBytes(object.material.baseColorTexture) + dataUrlBytes(object.material.normalTexture) + dataUrlBytes(object.material.roughnessTexture) + dataUrlBytes(object.material.metalnessTexture);
    return { objectId: object.id, name: object.name, type: object.type, visible: object.visible, triangleCount, textureBytes, bounds: boxPayload(objectBox(doc, object, worldCache, boxCache)), topologyStatus: object.topologyStatus ?? (isPrimitiveType(object.type) || object.type === 'boolean' ? 'manifold' : 'unknown'), nonManifoldEdgeCount: object.nonManifoldEdgeCount ?? 0 };
  });
  const totalTriangleCount = objectMetrics.filter((metric) => metric.visible).reduce((sum, metric) => sum + metric.triangleCount, 0);
  const totalTextureBytes = objectMetrics.reduce((sum, metric) => sum + metric.textureBytes, 0);
  const renderable = doc.objects.filter((object) => object.visible && (isPrimitiveType(object.type) || object.type === 'boolean'));
  const intersections: Array<{ objectIds: [string, string]; overlap: Vec3 }> = [];
  for (let leftIndex = 0; leftIndex < renderable.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < renderable.length; rightIndex += 1) {
      const left = renderable[leftIndex]; const right = renderable[rightIndex];
      if (left.parentId === right.id || right.parentId === left.id) continue;
      if (left.boolean?.operandIds.includes(right.id) || right.boolean?.operandIds.includes(left.id)) continue;
      const leftBox = objectBox(doc, left, worldCache, boxCache); const rightBox = objectBox(doc, right, worldCache, boxCache);
      if (leftBox && rightBox && leftBox.intersectsBox(rightBox)) {
        const overlap = leftBox.clone().intersect(rightBox).getSize(new Vector3());
        if (overlap.x > 1e-5 && overlap.y > 1e-5 && overlap.z > 1e-5) intersections.push({ objectIds: [left.id, right.id], overlap: overlap.toArray() as Vec3 });
      }
    }
  }
  if (hiddenObjectCount) warnings.push({ code: 'hidden_inputs', severity: 'info', message: `${hiddenObjectCount} hidden object${hiddenObjectCount === 1 ? '' : 's'} remain in the feature graph.`, objectIds: doc.objects.filter((object) => !object.visible).map((object) => object.id) });
  if (doc.objects.length > 350) warnings.push({ code: 'object_budget', severity: 'warning', message: 'The scene is approaching the recommended 500-object limit.', objectIds: [] });
  if (totalTriangleCount > 250_000) warnings.push({ code: 'triangle_budget', severity: totalTriangleCount > 1_000_000 ? 'error' : 'warning', message: `The visible scene contains about ${totalTriangleCount.toLocaleString()} triangles.`, objectIds: [] });
  const largeScaleIds = doc.objects.filter((object) => Math.max(...object.scale) > 100).map((object) => object.id);
  if (largeScaleIds.length) warnings.push({ code: 'large_scale', severity: 'warning', message: 'One or more objects use unusually large scale values.', objectIds: largeScaleIds });
  const oversizedTextureIds = objectMetrics.filter((metric) => metric.textureBytes > 4 * 1024 * 1024).map((metric) => metric.objectId);
  if (oversizedTextureIds.length) warnings.push({ code: 'oversized_texture', severity: 'warning', message: 'One or more objects embed over 4 MB of texture data.', objectIds: oversizedTextureIds });
  if (totalTextureBytes > 16 * 1024 * 1024) warnings.push({ code: 'texture_budget', severity: 'warning', message: 'Embedded textures exceed the recommended 16 MB scene budget.', objectIds: [] });
  if (intersections.length) warnings.push({ code: 'intersection', severity: 'info', message: `${intersections.length} overlapping object pair${intersections.length === 1 ? '' : 's'} detected.`, objectIds: [...new Set(intersections.flatMap((item) => item.objectIds))] });
  const nonManifoldIds = doc.objects.filter((object) => object.topologyStatus === 'non_manifold').map((object) => object.id);
  if (nonManifoldIds.length) warnings.push({ code: 'non_manifold', severity: 'error', message: 'Imported meshes with non-manifold edges were detected.', objectIds: nonManifoldIds });
  const missingMaterialIds = doc.objects.filter((object) => object.missingMaterial).map((object) => object.id);
  if (missingMaterialIds.length) warnings.push({ code: 'missing_material', severity: 'warning', message: 'Imported meshes without supported PBR materials were detected.', objectIds: missingMaterialIds });
  const unknownBoundsIds = objectMetrics.filter((metric) => metric.type === 'glb_node' && !metric.bounds).map((metric) => metric.objectId);
  if (unknownBoundsIds.length) warnings.push({ code: 'unknown_bounds', severity: 'info', message: 'Imported mesh bounds are unavailable until the asset is rendered.', objectIds: unknownBoundsIds });
  return {
    revision: doc.revision,
    objectCount: doc.objects.length,
    visibleObjectCount: doc.objects.length - hiddenObjectCount,
    hiddenObjectCount,
    booleanObjectCount: doc.objects.filter((object) => object.type === 'boolean').length,
    importedNodeCount: doc.objects.filter((object) => object.type === 'glb_node').length,
    texturedObjectCount: objectMetrics.filter((metric) => metric.textureBytes > 0).length,
    totalTriangleCount,
    totalTextureBytes,
    intersections,
    objects: objectMetrics,
    warnings,
    status: warnings.some((warning) => warning.severity === 'error') ? 'error' : warnings.some((warning) => warning.severity === 'warning') ? 'review' : 'healthy',
  };
}

export function compactObjectSnapshot(object: StudioObject | null) {
  if (!object) return null;
  const clone = structuredClone(object) as StudioObject & Record<string, unknown>;
  const slots = ['baseColorTexture', 'normalTexture', 'roughnessTexture', 'metalnessTexture'] as const;
  const textures = Object.fromEntries(slots.flatMap((slot) => object.material[slot] ? [[slot, { embedded: true, byteLength: dataUrlBytes(object.material[slot]) }]] : []));
  slots.forEach((slot) => { delete clone.material[slot]; });
  if (object.assetDataUrl) {
    clone.asset = { embedded: true, byteLength: dataUrlBytes(object.assetDataUrl) };
    delete clone.assetDataUrl;
  }
  if (Object.keys(textures).length) clone.textures = textures;
  return clone;
}
