import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { downloadBlob, fileToDataUrl, safeFilename } from '@/lib/persistence';
import { getSceneRoot } from '@/lib/scene-runtime';
import { useStudioStore } from '@/lib/studio-store';

export async function exportSceneGlb() {
  const root = getSceneRoot();
  if (!root) throw new Error('The 3D scene is not ready yet.');
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true, onlyVisible: true });
  if (!(result instanceof ArrayBuffer)) throw new Error('Could not create a binary GLB export.');
  const title = useStudioStore.getState().doc.title;
  downloadBlob(new Blob([result], { type: 'model/gltf-binary' }), `${safeFilename(title)}.glb`);
}

export async function validateAndEncodeGlb(file: File) {
  if (file.size > 30 * 1024 * 1024) throw new Error('GLB files must be 30 MB or smaller.');
  const buffer = await file.arrayBuffer();
  const loader = new GLTFLoader();
  await loader.parseAsync(buffer, '');
  const dataUrl = await fileToDataUrl(file);
  return dataUrl.replace(/^data:[^;]+;base64,/, 'data:model/gltf-binary;base64,');
}
