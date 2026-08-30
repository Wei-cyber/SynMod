import {
  Color,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { downloadBlob, fileToDataUrl, safeFilename } from '@/lib/persistence';
import { getRenderRuntime, getSceneRoot } from '@/lib/scene-runtime';
import { useStudioStore } from '@/lib/studio-store';
import type { GlbNodeDescriptor, Vec3 } from '@/lib/studio-types';

export async function exportSceneGlb() {
  const root = getSceneRoot();
  if (!root) throw new Error('The 3D scene is not ready yet.');
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true, onlyVisible: true });
  if (!(result instanceof ArrayBuffer)) throw new Error('Could not create a binary GLB export.');
  const title = useStudioStore.getState().doc.title;
  downloadBlob(new Blob([result], { type: 'model/gltf-binary' }), `${safeFilename(title)}.glb`);
}

export async function exportViewportPng(multiplier = 2) {
  const runtime = getRenderRuntime();
  if (!runtime) throw new Error('The 3D viewport is not ready yet.');
  const size = runtime.renderer.getSize(new Vector2());
  const width = Math.min(4096, Math.max(1, Math.floor(size.x * multiplier)));
  const height = Math.min(4096, Math.max(1, Math.floor(size.y * multiplier)));
  const target = new WebGLRenderTarget(width, height, { depthBuffer: true });
  const previousTarget = runtime.renderer.getRenderTarget();
  const pixels = new Uint8Array(width * height * 4);
  try {
    runtime.renderer.setRenderTarget(target);
    runtime.renderer.render(runtime.scene, runtime.camera);
    runtime.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  } finally {
    runtime.renderer.setRenderTarget(previousTarget);
    target.dispose();
  }
  const flipped = new Uint8ClampedArray(pixels.length);
  const rowLength = width * 4;
  for (let row = 0; row < height; row += 1) {
    flipped.set(pixels.subarray(row * rowLength, (row + 1) * rowLength), (height - row - 1) * rowLength);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare the rendered image.');
  context.putImageData(new ImageData(flipped, width, height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG export failed.')), 'image/png'));
  downloadBlob(blob, `${safeFilename(useStudioStore.getState().doc.title)}-render.png`);
}

function materialDescriptor(material: unknown) {
  const candidate = Array.isArray(material) ? material[0] : material;
  if (!(candidate instanceof MeshStandardMaterial)) return undefined;
  return {
    color: `#${candidate.color.getHexString()}`,
    roughness: candidate.roughness,
    metalness: candidate.metalness,
    opacity: candidate.opacity,
    emissive: `#${candidate.emissive.getHexString()}`,
    emissiveIntensity: candidate.emissiveIntensity,
    wireframe: candidate.wireframe,
  };
}

export async function validateAndEncodeGlb(file: File) {
  if (file.size > 30 * 1024 * 1024) throw new Error('GLB files must be 30 MB or smaller.');
  const buffer = await file.arrayBuffer();
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(buffer, '');
  const traversed: typeof gltf.scene.children = [];
  gltf.scene.traverse((node) => traversed.push(node));
  const indexByUuid = new Map(traversed.map((node, index) => [node.uuid, index]));
  const nodes: GlbNodeDescriptor[] = traversed.slice(1).map((node, offset) => {
    const mesh = node instanceof Mesh ? node : null;
    const parentIndex = node.parent ? indexByUuid.get(node.parent.uuid) : undefined;
    return {
      nodeIndex: offset + 1,
      parentNodeIndex: parentIndex && parentIndex > 0 ? parentIndex : null,
      name: node.name.trim() || `${mesh ? 'Mesh' : 'Node'} ${offset + 1}`,
      kind: mesh ? 'mesh' : 'group',
      position: node.position.toArray() as Vec3,
      rotation: [MathUtils.radToDeg(node.rotation.x), MathUtils.radToDeg(node.rotation.y), MathUtils.radToDeg(node.rotation.z)],
      scale: node.scale.toArray() as Vec3,
      visible: node.visible,
      material: mesh ? materialDescriptor(mesh.material) : undefined,
    };
  });
  gltf.scene.traverse((node) => {
    if (node instanceof Mesh) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => material.dispose());
      node.geometry.dispose();
    }
  });
  const dataUrl = await fileToDataUrl(file);
  return {
    assetDataUrl: dataUrl.replace(/^data:[^;]+;base64,/, 'data:model/gltf-binary;base64,'),
    nodes,
  };
}

export function colorToHex(color: Color) {
  return `#${color.getHexString()}`;
}
