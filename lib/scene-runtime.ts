import type { Camera, Group, Scene, WebGLRenderer } from 'three';

let sceneRoot: Group | null = null;
let renderRuntime: { renderer: WebGLRenderer; scene: Scene; camera: Camera } | null = null;

export function setSceneRoot(root: Group | null) {
  sceneRoot = root;
}

export function getSceneRoot() {
  return sceneRoot;
}

export function setRenderRuntime(runtime: { renderer: WebGLRenderer; scene: Scene; camera: Camera } | null) {
  renderRuntime = runtime;
}

export function getRenderRuntime() {
  return renderRuntime;
}
