export type PrimitiveType = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus';
export type BooleanOperation = 'union' | 'subtract' | 'intersect';
export type ObjectType = PrimitiveType | 'boolean' | 'group' | 'glb' | 'glb_node';
export type Actor = 'human' | 'agent';
export type Vec3 = [number, number, number];
export type ToolMode = 'translate' | 'rotate' | 'scale';
export type EnvironmentPreset = 'studio' | 'sunset' | 'warehouse' | 'night';
export type FeatureKind = 'source' | 'transform' | 'geometry' | 'material' | 'boolean' | 'hierarchy' | 'visibility' | 'environment' | 'version';

export interface PrimitiveGeometry {
  width: number;
  height: number;
  depth: number;
  radius: number;
  radiusTop: number;
  radiusBottom: number;
  tube: number;
  radialSegments: number;
  heightSegments: number;
}

export interface StudioMaterial {
  color: string;
  roughness: number;
  metalness: number;
  wireframe: boolean;
  opacity: number;
  emissive: string;
  emissiveIntensity: number;
  baseColorTexture?: string;
  normalTexture?: string;
  roughnessTexture?: string;
  metalnessTexture?: string;
}

export interface BooleanFeature {
  operation: BooleanOperation;
  operandIds: [string, string];
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
  geometry?: PrimitiveGeometry;
  visible: boolean;
  locked: boolean;
  boolean?: BooleanFeature;
  assetDataUrl?: string;
  assetRootId?: string;
  assetNodeIndex?: number;
  assetNodeKind?: 'group' | 'mesh';
  triangleCount?: number;
  topologyStatus?: 'manifold' | 'non_manifold' | 'unknown';
  nonManifoldEdgeCount?: number;
  missingMaterial?: boolean;
}

export interface GlbNodeDescriptor {
  nodeIndex: number;
  parentNodeIndex: number | null;
  name: string;
  kind: 'group' | 'mesh';
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  material?: Partial<StudioMaterial>;
  triangleCount?: number;
  topologyStatus?: 'manifold' | 'non_manifold' | 'unknown';
  nonManifoldEdgeCount?: number;
  missingMaterial?: boolean;
}

export interface FeatureRecord {
  id: string;
  kind: FeatureKind;
  label: string;
  objectIds: string[];
  revision: number;
  createdAt: string;
  actor: Actor;
}

export interface SceneSnapshot {
  title: string;
  revision: number;
  objects: StudioObject[];
  settings: SceneDocument['settings'];
  features: FeatureRecord[];
}

export interface SceneCheckpoint {
  id: string;
  name: string;
  createdAt: string;
  sourceRevision: number;
  snapshot: SceneSnapshot;
}

export interface SceneDocument {
  schemaVersion: 3;
  projectId: string;
  title: string;
  revision: number;
  updatedAt: string;
  objects: StudioObject[];
  features: FeatureRecord[];
  checkpoints: SceneCheckpoint[];
  branch?: {
    parentProjectId: string;
    checkpointId?: string;
  };
  settings: {
    gridSize: number;
    snapEnabled: boolean;
    environment: EnvironmentPreset;
    exposure: number;
    backgroundColor: string;
    shadows: boolean;
  };
}

export interface ActivityEntry {
  id: string;
  actor: Actor;
  label: string;
  timestamp: number;
  objectIds: string[];
  durationMs?: number;
}

export type AgentTaskStatus = 'idle' | 'running' | 'applied' | 'conflict' | 'cancelled' | 'failed';

export interface AgentTaskState {
  token: string;
  title: string;
  status: AgentTaskStatus;
  startedAt: number;
  durationMs?: number;
  affectedObjectIds: string[];
  error?: string;
}

export type SceneCommand =
  | {
      type: 'add_primitive';
      primitiveType: PrimitiveType;
      name?: string;
      position?: Vec3;
      rotation?: Vec3;
      scale?: Vec3;
      geometry?: Partial<PrimitiveGeometry>;
      material?: Partial<StudioMaterial>;
      objectId?: string;
    }
  | { type: 'import_glb'; name: string; assetDataUrl: string; nodes?: GlbNodeDescriptor[] }
  | { type: 'set_transform'; objectId: string; position?: Vec3; rotation?: Vec3; scale?: Vec3 }
  | { type: 'set_geometry'; objectId: string; geometry: Partial<PrimitiveGeometry> }
  | { type: 'set_material'; objectId: string; material: Partial<StudioMaterial> }
  | { type: 'set_visibility'; objectId: string; visible: boolean }
  | { type: 'set_snap'; enabled: boolean }
  | { type: 'set_environment'; environment?: EnvironmentPreset; exposure?: number; backgroundColor?: string; shadows?: boolean }
  | { type: 'boolean'; operation: BooleanOperation; operandIds: [string, string]; name?: string; resultId?: string }
  | { type: 'rename'; objectId: string; name: string }
  | { type: 'duplicate'; objectId: string; name?: string; offset?: Vec3; resultId?: string }
  | { type: 'delete'; objectId: string }
  | { type: 'group'; objectIds: string[]; name?: string; resultId?: string }
  | { type: 'ungroup'; groupId: string }
  | { type: 'create_checkpoint'; name: string }
  | { type: 'restore_checkpoint'; checkpointId: string }
  | { type: 'branch_project'; checkpointId?: string; name?: string }
  | { type: 'duplicate_project'; name?: string };

export const DEFAULT_MATERIAL: StudioMaterial = {
  color: '#e9e4d8',
  roughness: 0.58,
  metalness: 0.08,
  wireframe: false,
  opacity: 1,
  emissive: '#000000',
  emissiveIntensity: 0,
};

export const DEFAULT_GEOMETRY: PrimitiveGeometry = {
  width: 1,
  height: 1,
  depth: 1,
  radius: 0.5,
  radiusTop: 0.5,
  radiusBottom: 0.5,
  tube: 0.15,
  radialSegments: 32,
  heightSegments: 1,
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
  const { material, geometry, ...rest } = overrides;
  const typeGeometry = type === 'cone' ? { radiusTop: 0.02, radiusBottom: 0.5 } : {};
  return {
    id: createId(),
    name,
    type,
    position: [0, type === 'group' || type === 'glb_node' ? 0 : 0.5, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    parentId: null,
    visible: true,
    locked: false,
    ...rest,
    geometry: isPrimitiveType(type) ? { ...DEFAULT_GEOMETRY, ...typeGeometry, ...geometry } : geometry,
    material: { ...DEFAULT_MATERIAL, ...material },
  };
}

export function isPrimitiveType(type: ObjectType): type is PrimitiveType {
  return type === 'box' || type === 'sphere' || type === 'cylinder' || type === 'cone' || type === 'torus';
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
    geometry: { ...DEFAULT_GEOMETRY, radiusTop: 0.16, radiusBottom: 0.62 },
    material: { ...DEFAULT_MATERIAL, color: '#e9e4d8', roughness: 0.72 },
  });

  return {
    schemaVersion: 3,
    projectId: 'lamp-study',
    title: 'Lamp Study',
    revision: 1,
    updatedAt: new Date().toISOString(),
    objects: [base, lower, joint, upper, shade],
    features: [
      {
        id: 'feature-lamp-study',
        kind: 'source',
        label: 'Created Lamp Study primitives',
        objectIds: [base.id, lower.id, joint.id, upper.id, shade.id],
        revision: 1,
        createdAt: new Date().toISOString(),
        actor: 'human',
      },
    ],
    checkpoints: [],
    settings: {
      gridSize: 0.5,
      snapEnabled: true,
      environment: 'studio',
      exposure: 1,
      backgroundColor: '#20211d',
      shadows: true,
    },
  };
}

export function createRoverStudy(): SceneDocument {
  const assemblyId = 'rover-assembly';
  const charcoal = { ...DEFAULT_MATERIAL, color: '#252824', roughness: 0.38, metalness: 0.72 };
  const rubber = { ...DEFAULT_MATERIAL, color: '#171816', roughness: 0.88, metalness: 0.04 };
  const silver = { ...DEFAULT_MATERIAL, color: '#b7bcc0', roughness: 0.3, metalness: 0.82 };
  const blueGray = { ...DEFAULT_MATERIAL, color: '#506779', roughness: 0.42, metalness: 0.38 };
  const orange = { ...DEFAULT_MATERIAL, color: '#f15722', roughness: 0.32, metalness: 0.64 };
  const warmLight = { ...DEFAULT_MATERIAL, color: '#ffd9a0', roughness: 0.22, metalness: 0.05, emissive: '#ff9f43', emissiveIntensity: 4.5 };

  const assembly = makeObject('group', 'Lunar repair rover', { id: assemblyId });
  const chassisSource = makeObject('box', 'Chassis source', {
    id: 'rover-chassis-source', parentId: assemblyId, position: [0, 0.72, 0], scale: [3.6, 0.65, 2.7], visible: false, material: charcoal,
  });
  const axleCutter = makeObject('cylinder', 'Front axle cutter', {
    id: 'rover-front-axle-cutter', parentId: assemblyId, position: [1.2, 0.48, 0], rotation: [90, 0, 0], scale: [0.75, 3.4, 0.75], visible: false,
  });
  const chassis = makeObject('boolean', 'Chassis', {
    id: 'rover-chassis', parentId: assemblyId, material: charcoal,
    boolean: { operation: 'subtract', operandIds: [chassisSource.id, axleCutter.id] },
  });
  const deck = makeObject('box', 'Equipment deck', {
    id: 'rover-equipment-deck', parentId: assemblyId, position: [0, 1.08, 0], scale: [3, 0.18, 2.2], material: silver,
  });
  const cab = makeObject('box', 'Operator cab', {
    id: 'rover-operator-cab', parentId: assemblyId, position: [-1.05, 1.55, 0], scale: [1.2, 0.9, 1.4], material: blueGray,
  });
  const wheelSpecs: Array<[string, string, number, number]> = [
    ['rover-front-left-wheel', 'Front left wheel', 1.2, -1.55],
    ['rover-front-right-wheel', 'Front right wheel', 1.2, 1.55],
    ['rover-rear-left-wheel', 'Rear left wheel', -1.2, -1.55],
    ['rover-rear-right-wheel', 'Rear right wheel', -1.2, 1.55],
  ];
  const wheels = wheelSpecs.map(([id, name, x, z]) => makeObject('cylinder', name, {
    id, parentId: assemblyId, position: [x, 0.45, z], rotation: [90, 0, 0], scale: [0.9, 0.34, 0.9], material: rubber,
  }));
  const mast = makeObject('cylinder', 'Sensor mast', {
    id: 'rover-sensor-mast', parentId: assemblyId, position: [-0.95, 2.45, 0], scale: [0.16, 1, 0.16], material: silver,
  });
  const sensorHead = makeObject('sphere', 'Sensor head', {
    id: 'rover-sensor-head', parentId: assemblyId, position: [-0.95, 3.15, 0], scale: [0.55, 0.42, 0.55], material: silver,
  });
  const sensorHalo = makeObject('torus', 'Sensor halo', {
    id: 'rover-sensor-halo', parentId: assemblyId, position: [-0.95, 3.15, 0], geometry: { ...DEFAULT_GEOMETRY, radius: 0.42, tube: 0.07, radialSegments: 48 }, material: orange,
  });
  const headlights = [
    makeObject('sphere', 'Left headlight', { id: 'rover-left-headlight', parentId: assemblyId, position: [1.78, 0.78, -0.62], scale: [0.24, 0.24, 0.24], material: warmLight }),
    makeObject('sphere', 'Right headlight', { id: 'rover-right-headlight', parentId: assemblyId, position: [1.78, 0.78, 0.62], scale: [0.24, 0.24, 0.24], material: warmLight }),
  ];

  // The original five Lamp Study primitives become the articulated crane.
  const turntable = makeObject('cylinder', 'Crane turntable', {
    id: 'lamp-base', parentId: assemblyId, position: [0.25, 1.3, 0], scale: [1.25, 0.24, 1.25], material: orange,
  });
  const lowerBoom = makeObject('cylinder', 'Crane lower boom', {
    id: 'lamp-lower-arm', parentId: assemblyId, position: [0.3, 2.15, 0], rotation: [0, 0, -14], scale: [0.32, 1.7, 0.32], material: silver,
  });
  const elbow = makeObject('sphere', 'Crane elbow', {
    id: 'lamp-joint', parentId: assemblyId, position: [0.7, 2.96, 0], scale: [0.5, 0.5, 0.5], material: orange,
  });
  const upperBoom = makeObject('cylinder', 'Crane upper boom', {
    id: 'lamp-upper-arm', parentId: assemblyId, position: [1.18, 3.55, 0], rotation: [0, 0, -33], scale: [0.28, 1.55, 0.28], material: silver,
  });
  const gripperHousing = makeObject('cone', 'Gripper housing', {
    id: 'lamp-shade', parentId: assemblyId, position: [1.75, 4.12, 0], rotation: [0, 0, -90], scale: [0.7, 0.55, 0.7],
    geometry: { ...DEFAULT_GEOMETRY, radiusTop: 0.22, radiusBottom: 0.5 }, material: charcoal,
  });
  const wrist = makeObject('cylinder', 'Gripper wrist', {
    id: 'rover-gripper-wrist', parentId: assemblyId, position: [2.08, 4.12, 0], rotation: [0, 0, -90], scale: [0.38, 0.48, 0.38], material: orange,
  });
  const jaws = [
    makeObject('cylinder', 'Left gripper jaw', { id: 'rover-left-gripper-jaw', parentId: assemblyId, position: [2.48, 3.78, -0.3], rotation: [-18, 0, -20], scale: [0.18, 0.72, 0.18], material: charcoal }),
    makeObject('cylinder', 'Right gripper jaw', { id: 'rover-right-gripper-jaw', parentId: assemblyId, position: [2.48, 3.78, 0.3], rotation: [18, 0, -20], scale: [0.18, 0.72, 0.18], material: charcoal }),
  ];
  const objects = [assembly, chassisSource, axleCutter, chassis, deck, cab, ...wheels, mast, sensorHead, sensorHalo, ...headlights, turntable, lowerBoom, elbow, upperBoom, gripperHousing, wrist, ...jaws];
  const createdAt = new Date().toISOString();

  return {
    schemaVersion: 3,
    projectId: 'rover-study',
    title: 'Rover Study',
    revision: 1,
    updatedAt: createdAt,
    objects,
    features: [{
      id: 'feature-rover-study', kind: 'source', label: 'Created Rover Study demo', objectIds: objects.map((object) => object.id), revision: 1, createdAt, actor: 'human',
    }],
    checkpoints: [],
    settings: { gridSize: 0.5, snapEnabled: true, environment: 'warehouse', exposure: 1.15, backgroundColor: '#20211d', shadows: true },
  };
}

export function migrateUntouchedLampStudy(doc: SceneDocument): SceneDocument {
  const isUntouchedStarter = doc.projectId === 'lamp-study'
    && doc.title === 'Lamp Study'
    && doc.revision === 1
    && doc.objects.length === 5
    && doc.features.length === 1
    && doc.features[0]?.id === 'feature-lamp-study'
    && ['lamp-base', 'lamp-lower-arm', 'lamp-joint', 'lamp-upper-arm', 'lamp-shade'].every((id) => doc.objects.some((object) => object.id === id));
  if (!isUntouchedStarter) return doc;
  return { ...createRoverStudy(), projectId: doc.projectId };
}

export const PRIMITIVE_LABELS: Record<PrimitiveType, string> = {
  box: 'Box',
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  torus: 'Torus',
};
