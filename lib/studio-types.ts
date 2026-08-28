export type PrimitiveType = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus';
export type ObjectType = PrimitiveType | 'group' | 'glb';
export type Actor = 'human' | 'agent';
export type Vec3 = [number, number, number];
export type ToolMode = 'translate' | 'rotate' | 'scale';

export interface StudioMaterial {
  color: string;
  roughness: number;
  metalness: number;
  wireframe: boolean;
}

export interface StudioObject {
  id: string;
  name: string;
  type: ObjectType;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  parentId: string | null;
  material: StudioMaterial;
  assetDataUrl?: string;
}

export interface SceneDocument {
  schemaVersion: 1;
  projectId: string;
  title: string;
  revision: number;
  updatedAt: string;
  objects: StudioObject[];
  settings: {
    gridSize: number;
    snapEnabled: boolean;
  };
}

export interface ActivityEntry {
  id: string;
  actor: Actor;
  label: string;
  timestamp: number;
  objectIds: string[];
}

export type SceneCommand =
  | {
      type: 'add_primitive';
      primitiveType: PrimitiveType;
      name?: string;
      position?: Vec3;
      rotation?: Vec3;
      scale?: Vec3;
      material?: Partial<StudioMaterial>;
    }
  | { type: 'import_glb'; name: string; assetDataUrl: string }
  | { type: 'set_transform'; objectId: string; position?: Vec3; rotation?: Vec3; scale?: Vec3 }
  | { type: 'set_material'; objectId: string; material: Partial<StudioMaterial> }
  | { type: 'rename'; objectId: string; name: string }
  | { type: 'duplicate'; objectId: string; name?: string; offset?: Vec3 }
  | { type: 'delete'; objectId: string }
  | { type: 'group'; objectIds: string[]; name?: string }
  | { type: 'ungroup'; groupId: string };

export const DEFAULT_MATERIAL: StudioMaterial = {
  color: '#e9e4d8',
  roughness: 0.58,
  metalness: 0.08,
  wireframe: false,
};

export function createId(prefix = 'object') {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export function makeObject(
  type: ObjectType,
  name: string,
  overrides: Partial<StudioObject> = {},
): StudioObject {
  const { material, ...rest } = overrides;
  return {
    id: createId(),
    name,
    type,
    position: [0, type === 'group' ? 0 : 0.5, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    parentId: null,
    ...rest,
    material: { ...DEFAULT_MATERIAL, ...material },
  };
}

export function createLampStudy(): SceneDocument {
  const base = makeObject('cylinder', 'Base', {
    id: 'lamp-base',
    position: [0, 0.15, 0],
    scale: [2.6, 0.3, 2.6],
    material: { ...DEFAULT_MATERIAL, color: '#292a25', roughness: 0.58, metalness: 0.22 },
  });
  const lower = makeObject('cylinder', 'Lower arm', {
    id: 'lamp-lower-arm',
    position: [0, 1.45, 0],
    rotation: [0, 0, -14],
    scale: [0.36, 2.5, 0.36],
    material: { ...DEFAULT_MATERIAL, color: '#f15722', roughness: 0.45 },
  });
  const joint = makeObject('sphere', 'Joint', {
    id: 'lamp-joint',
    position: [0.32, 2.65, 0],
    scale: [0.7, 0.7, 0.7],
    material: { ...DEFAULT_MATERIAL, color: '#f1eee4', roughness: 0.35, metalness: 0.28 },
  });
  const upper = makeObject('cylinder', 'Upper arm', {
    id: 'lamp-upper-arm',
    position: [0.92, 3.56, 0],
    rotation: [0, 0, -33],
    scale: [0.3, 2.05, 0.3],
    material: { ...DEFAULT_MATERIAL, color: '#292a25', roughness: 0.48 },
  });
  const shade = makeObject('cone', 'Shade', {
    id: 'lamp-shade',
    position: [1.55, 4.3, 0],
    rotation: [0, 0, -27.5],
    scale: [1.9, 1.25, 1.9],
    material: { ...DEFAULT_MATERIAL, color: '#e9e4d8', roughness: 0.72 },
  });

  return {
    schemaVersion: 1,
    projectId: 'lamp-study',
    title: 'Lamp Study',
    revision: 1,
    updatedAt: new Date().toISOString(),
    objects: [base, lower, joint, upper, shade],
    settings: { gridSize: 0.5, snapEnabled: true },
  };
}

export const PRIMITIVE_LABELS: Record<PrimitiveType, string> = {
  box: 'Box',
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  torus: 'Torus',
};
