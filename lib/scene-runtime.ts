import type { Group } from 'three';

let sceneRoot: Group | null = null;

export function setSceneRoot(root: Group | null) {
  sceneRoot = root;
}

export function getSceneRoot() {
  return sceneRoot;
}
