'use client';

import { BufferGeometry, Float32BufferAttribute } from 'three';
import Module, { type Manifold, type ManifoldToplevel } from 'manifold-3d';

import { DEFAULT_GEOMETRY, isPrimitiveType, type StudioObject } from '@/lib/studio-types';

let manifoldModule: Promise<ManifoldToplevel> | null = null;

async function getModule() {
  if (!manifoldModule) {
    manifoldModule = Module().then((runtime) => {
      runtime.setup();
      return runtime;
    });
  }
  return manifoldModule;
}

function primitiveManifold(runtime: ManifoldToplevel, object: StudioObject): Manifold {
  if (!isPrimitiveType(object.type)) throw new Error(`${object.name} is not a primitive.`);
  const geometry = object.geometry ?? DEFAULT_GEOMETRY;
  let solid: Manifold;
  switch (object.type) {
    case 'box':
      solid = runtime.Manifold.cube([geometry.width, geometry.height, geometry.depth], true);
      break;
    case 'sphere':
      solid = runtime.Manifold.sphere(geometry.radius, geometry.radialSegments);
      break;
    case 'cylinder':
      solid = runtime.Manifold.cylinder(geometry.height, geometry.radiusBottom, geometry.radiusTop, geometry.radialSegments, true).rotate([-90, 0, 0]);
      break;
    case 'cone':
      solid = runtime.Manifold.cylinder(geometry.height, geometry.radiusBottom, geometry.radiusTop, geometry.radialSegments, true).rotate([-90, 0, 0]);
      break;
    case 'torus': {
      const section = runtime.CrossSection.circle(geometry.tube, Math.max(8, Math.floor(geometry.radialSegments / 2))).translate([geometry.radius, 0]);
      solid = section.revolve(geometry.radialSegments).rotate([-90, 0, 0]);
      section.delete();
      break;
    }
  }
  return solid;
}

function transformSolid(solid: Manifold, object: StudioObject) {
  const transformed = solid.scale(object.scale).rotate(object.rotation).translate(object.position);
  solid.delete();
  return transformed;
}

function evaluateObject(runtime: ManifoldToplevel, object: StudioObject, objects: StudioObject[], stack: Set<string>): Manifold {
  if (stack.has(object.id)) throw new Error('Boolean dependency cycle detected.');
  if (isPrimitiveType(object.type)) return transformSolid(primitiveManifold(runtime, object), object);
  if (object.type !== 'boolean' || !object.boolean) throw new Error(`${object.name} cannot be used in a Boolean operation.`);
  stack.add(object.id);
  const leftObject = objects.find((candidate) => candidate.id === object.boolean!.operandIds[0]);
  const rightObject = objects.find((candidate) => candidate.id === object.boolean!.operandIds[1]);
  if (!leftObject || !rightObject) throw new Error('A Boolean operand is missing.');
  const left = evaluateObject(runtime, leftObject, objects, stack);
  const right = evaluateObject(runtime, rightObject, objects, stack);
  let result: Manifold;
  if (object.boolean.operation === 'union') result = left.add(right);
  else if (object.boolean.operation === 'subtract') result = left.subtract(right);
  else result = left.intersect(right);
  left.delete();
  right.delete();
  stack.delete(object.id);
  return transformSolid(result, object);
}

export async function evaluateBooleanGeometry(object: StudioObject, objects: StudioObject[]) {
  if (object.type !== 'boolean' || !object.boolean) throw new Error('Object is not a Boolean feature.');
  const runtime = await getModule();
  const leftObject = objects.find((candidate) => candidate.id === object.boolean!.operandIds[0]);
  const rightObject = objects.find((candidate) => candidate.id === object.boolean!.operandIds[1]);
  if (!leftObject || !rightObject) throw new Error('A Boolean operand is missing.');
  const left = evaluateObject(runtime, leftObject, objects, new Set([object.id]));
  const right = evaluateObject(runtime, rightObject, objects, new Set([object.id]));
  let result: Manifold;
  if (object.boolean.operation === 'union') result = left.add(right);
  else if (object.boolean.operation === 'subtract') result = left.subtract(right);
  else result = left.intersect(right);
  left.delete();
  right.delete();
  const mesh = result.getMesh();
  result.delete();
  const positions = new Float32Array(mesh.numVert * 3);
  for (let vertex = 0; vertex < mesh.numVert; vertex += 1) {
    const source = vertex * mesh.numProp;
    const target = vertex * 3;
    positions[target] = mesh.vertProperties[source];
    positions[target + 1] = mesh.vertProperties[source + 1];
    positions[target + 2] = mesh.vertProperties[source + 2];
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(Array.from(mesh.triVerts));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
