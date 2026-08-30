'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Edges, Environment, Grid, OrbitControls, TransformControls, useGLTF } from '@react-three/drei';
import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import {
  Box3,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import { evaluateBooleanGeometry } from '@/lib/manifold-geometry';
import { setRenderRuntime, setSceneRoot } from '@/lib/scene-runtime';
import { useStudioStore } from '@/lib/studio-store';
import { DEFAULT_GEOMETRY, type StudioMaterial, type StudioObject, type Vec3 } from '@/lib/studio-types';

function Geometry({ object }: { object: StudioObject }) {
  const geometry = object.geometry ?? DEFAULT_GEOMETRY;
  if (object.type === 'box') return <boxGeometry args={[geometry.width, geometry.height, geometry.depth]} />;
  if (object.type === 'sphere') return <sphereGeometry args={[geometry.radius, geometry.radialSegments, Math.max(8, Math.floor(geometry.radialSegments * 0.75))]} />;
  if (object.type === 'cylinder' || object.type === 'cone') return <cylinderGeometry args={[geometry.radiusTop, geometry.radiusBottom, geometry.height, geometry.radialSegments, geometry.heightSegments]} />;
  return <torusGeometry args={[geometry.radius, geometry.tube, Math.max(8, Math.floor(geometry.radialSegments / 2)), geometry.radialSegments]} />;
}

function useOptionalTexture(dataUrl: string | undefined, color = false) {
  const [loaded, setLoaded] = useState<{ dataUrl: string; texture: Texture } | null>(null);
  useEffect(() => {
    let active = true;
    if (!dataUrl) return;
    let pendingTexture: Texture | null = null;
    const loader = new TextureLoader();
    loader.load(dataUrl, (loaded) => {
      if (!active) {
        loaded.dispose();
        return;
      }
      if (color) loaded.colorSpace = SRGBColorSpace;
      pendingTexture = loaded;
      setLoaded({ dataUrl, texture: loaded });
    });
    return () => {
      active = false;
      pendingTexture?.dispose();
    };
  }, [dataUrl, color]);
  if (!loaded || loaded.dataUrl !== dataUrl) return null;
  return loaded.texture;
}

function SurfaceMaterial({ material, selected, pulsing, side }: { material: StudioMaterial; selected: boolean; pulsing: boolean; side?: typeof DoubleSide }) {
  const materialRef = useRef<MeshStandardMaterial>(null);
  const pulseStarted = useRef(0);
  const map = useOptionalTexture(material.baseColorTexture, true);
  const normalMap = useOptionalTexture(material.normalTexture);
  const roughnessMap = useOptionalTexture(material.roughnessTexture);
  const metalnessMap = useOptionalTexture(material.metalnessTexture);
  useEffect(() => { if (pulsing) pulseStarted.current = Date.now(); }, [pulsing]);
  useFrame(() => {
    if (!materialRef.current) return;
    const elapsed = Date.now() - pulseStarted.current;
    const pulse = pulsing && elapsed < 1_100 ? Math.max(0, 1 - elapsed / 1_100) * 0.8 : 0;
    materialRef.current.emissiveIntensity = Math.max(material.emissiveIntensity, pulse, selected ? 0.14 : 0);
  });
  return (
    <meshStandardMaterial
      ref={materialRef}
      color={material.color}
      roughness={material.roughness}
      metalness={material.metalness}
      wireframe={material.wireframe}
      opacity={material.opacity}
      transparent={material.opacity < 1}
      emissive={pulsing || selected ? '#f15722' : material.emissive}
      emissiveIntensity={material.emissiveIntensity}
      map={map}
      normalMap={normalMap}
      roughnessMap={roughnessMap}
      metalnessMap={metalnessMap}
      side={side}
    />
  );
}

function ImportedAsset({ object, overrides, selection }: { object: StudioObject; overrides: StudioObject[]; selection: string[] }) {
  const { scene } = useGLTF(object.assetDataUrl!);
  const clone = useMemo(() => {
    const result = scene.clone(true);
    result.traverse((node) => {
      if (node instanceof Mesh) {
        node.material = Array.isArray(node.material) ? node.material.map((material) => material.clone()) : node.material.clone();
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    return result;
  }, [scene]);
  useEffect(() => {
    let active = true;
    const loadedTextures: Texture[] = [];
    const loader = new TextureLoader();
    const nodes: typeof clone.children = [];
    clone.traverse((node) => nodes.push(node));
    overrides.forEach((override) => {
      const node = nodes[override.assetNodeIndex ?? -1];
      if (!node) return;
      node.name = override.name;
      node.position.set(...override.position);
      node.rotation.set(...override.rotation.map(MathUtils.degToRad) as Vec3);
      node.scale.set(...override.scale);
      node.visible = override.visible;
      if (node instanceof Mesh) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((candidate) => {
          if (!(candidate instanceof MeshStandardMaterial)) return;
          candidate.color.set(override.material.color);
          candidate.roughness = override.material.roughness;
          candidate.metalness = override.material.metalness;
          candidate.opacity = override.material.opacity;
          candidate.transparent = override.material.opacity < 1;
          candidate.wireframe = override.material.wireframe;
          candidate.emissive.set(selection.includes(override.id) ? '#f15722' : override.material.emissive);
          candidate.emissiveIntensity = selection.includes(override.id) ? 0.25 : override.material.emissiveIntensity;
          const attach = (url: string | undefined, slot: 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap', color = false) => {
            if (!url) return;
            loader.load(url, (texture) => {
              if (!active) {
                texture.dispose();
                return;
              }
              if (color) texture.colorSpace = SRGBColorSpace;
              loadedTextures.push(texture);
              candidate[slot] = texture;
              candidate.needsUpdate = true;
            });
          };
          attach(override.material.baseColorTexture, 'map', true);
          attach(override.material.normalTexture, 'normalMap');
          attach(override.material.roughnessTexture, 'roughnessMap');
          attach(override.material.metalnessTexture, 'metalnessMap');
        });
      }
    });
    return () => {
      active = false;
      loadedTextures.forEach((texture) => texture.dispose());
    };
  }, [clone, overrides, selection]);
  useEffect(() => () => {
    clone.traverse((node) => {
      if (node instanceof Mesh) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => material.dispose());
      }
    });
  }, [clone]);
  return <primitive object={clone} />;
}

function BooleanMesh({ object, objects, selected, pulsing }: { object: StudioObject; objects: StudioObject[]; selected: boolean; pulsing: boolean }) {
  const [geometry, setGeometry] = useState<Awaited<ReturnType<typeof evaluateBooleanGeometry>> | null>(null);
  const setError = useStudioStore((state) => state.setError);
  useEffect(() => {
    let active = true;
    void evaluateBooleanGeometry(object, objects)
      .then((next) => {
        if (!active) {
          next.dispose();
          return;
        }
        setGeometry((current) => {
          current?.dispose();
          return next;
        });
      })
      .catch((error) => active && setError(error instanceof Error ? `Boolean evaluation failed: ${error.message}` : 'Boolean evaluation failed.'));
    return () => { active = false; };
  }, [object, objects, setError]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <SurfaceMaterial material={object.material} selected={selected} pulsing={pulsing} />
      {selected && <Edges color="#ff7137" threshold={12} />}
    </mesh>
  );
}

function ObjectSurface({ object, objects, selected, pulsing, selection }: { object: StudioObject; objects: StudioObject[]; selected: boolean; pulsing: boolean; selection: string[] }) {
  if (object.type === 'glb') {
    return (
      <Suspense fallback={null}>
        <ImportedAsset object={object} overrides={objects.filter((candidate) => candidate.assetRootId === object.id)} selection={selection} />
      </Suspense>
    );
  }
  if (object.type === 'boolean') return <BooleanMesh object={object} objects={objects} selected={selected} pulsing={pulsing} />;
  if (object.type === 'group' || object.type === 'glb_node') return null;
  return (
    <mesh castShadow receiveShadow>
      <Geometry object={object} />
      <SurfaceMaterial material={object.material} selected={selected} pulsing={pulsing} side={object.type === 'cone' ? DoubleSide : undefined} />
      {selected && <Edges color="#ff7137" threshold={12} />}
    </mesh>
  );
}

function SceneNode({ object, objects }: { object: StudioObject; objects: StudioObject[] }) {
  const [node, setNode] = useState<Group | null>(null);
  const selection = useStudioStore((state) => state.selection);
  const toolMode = useStudioStore((state) => state.toolMode);
  const snapEnabled = useStudioStore((state) => state.doc.settings.snapEnabled);
  const pulse = useStudioStore((state) => state.lastAgentChange);
  const execute = useStudioStore((state) => state.execute);
  const select = useStudioStore((state) => state.select);
  const selected = selection.length === 1 && selection[0] === object.id;
  const pulsing = Boolean(pulse?.objectIds.includes(object.id));
  const children = objects.filter((item) => item.parentId === object.id);

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const next = event.nativeEvent.shiftKey
      ? selection.includes(object.id)
        ? selection.filter((id) => id !== object.id)
        : [...selection, object.id]
      : [object.id];
    select(next);
  };

  const commitTransform = () => {
    if (!node) return;
    execute({
      type: 'set_transform',
      objectId: object.id,
      position: node.position.toArray() as Vec3,
      rotation: [MathUtils.radToDeg(node.rotation.x), MathUtils.radToDeg(node.rotation.y), MathUtils.radToDeg(node.rotation.z)],
      scale: node.scale.toArray() as Vec3,
    });
  };

  if (!object.visible && object.type !== 'glb_node') return null;
  return (
    <>
      <group
        ref={setNode}
        name={`model-object-${object.id}`}
        position={object.position}
        rotation={object.rotation.map(MathUtils.degToRad) as Vec3}
        scale={object.scale}
        onClick={onClick}
      >
        <ObjectSurface object={object} objects={objects} selected={selection.includes(object.id)} pulsing={pulsing} selection={selection} />
        {children.map((child) => <SceneNode key={child.id} object={child} objects={objects} />)}
      </group>
      {selected && !object.locked && node && (
        <TransformControls
          object={node}
          mode={toolMode}
          translationSnap={snapEnabled ? 0.5 : null}
          rotationSnap={snapEnabled ? MathUtils.degToRad(15) : null}
          scaleSnap={snapEnabled ? 0.1 : null}
          onMouseUp={commitTransform}
        />
      )}
    </>
  );
}

function CameraBridge() {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const focusRequest = useStudioStore((state) => state.focusRequest);
  const cameraRequest = useStudioStore((state) => state.cameraRequest);
  const { camera, scene } = useThree();

  useEffect(() => {
    if (!focusRequest || !controlsRef.current) return;
    const box = new Box3();
    focusRequest.objectIds.forEach((id) => {
      const target = scene.getObjectByName(`model-object-${id}`);
      if (target) box.expandByObject(target);
    });
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const size = Math.max(1, box.getSize(new Vector3()).length());
    controlsRef.current.target.copy(center);
    camera.position.copy(center.clone().add(new Vector3(size * 1.1, size * 0.8, size * 1.4)));
    camera.lookAt(center);
    controlsRef.current.update();
  }, [focusRequest, camera, scene]);

  useEffect(() => {
    if (!cameraRequest || !controlsRef.current) return;
    const target = controlsRef.current.target.clone();
    const distance = Math.max(7, camera.position.distanceTo(target));
    const offset = cameraRequest.preset === 'top'
      ? new Vector3(0, distance, 0.01)
      : cameraRequest.preset === 'front'
        ? new Vector3(0, distance * 0.18, distance)
        : new Vector3(distance * 0.7, distance * 0.55, distance * 0.85);
    camera.position.copy(target.clone().add(offset));
    camera.lookAt(target);
    controlsRef.current.update();
  }, [cameraRequest, camera]);

  return <OrbitControls ref={controlsRef} makeDefault target={[0.4, 2.1, 0]} minDistance={2} maxDistance={40} />;
}

function RenderBridge() {
  const { gl, scene, camera } = useThree();
  const exposure = useStudioStore((state) => state.doc.settings.exposure);
  useEffect(() => {
    updateRendererExposure(gl, exposure);
  }, [gl, exposure]);
  useEffect(() => {
    setRenderRuntime({ renderer: gl, scene, camera });
    return () => setRenderRuntime(null);
  }, [gl, scene, camera]);
  return null;
}

function updateRendererExposure(renderer: WebGLRenderer, exposure: number) {
  renderer.toneMappingExposure = exposure;
}

function SceneGraph() {
  const rootRef = useRef<Group>(null);
  const objects = useStudioStore((state) => state.doc.objects);
  const select = useStudioStore((state) => state.select);
  useEffect(() => {
    setSceneRoot(rootRef.current);
    return () => setSceneRoot(null);
  }, []);
  return (
    <group ref={rootRef} name="model-room-scene" onPointerMissed={() => select([])}>
      {objects.filter((object) => !object.parentId).map((object) => <SceneNode key={object.id} object={object} objects={objects} />)}
    </group>
  );
}

export function StudioCanvas() {
  const settings = useStudioStore((state) => state.doc.settings);
  return (
    <Canvas shadows={settings.shadows} camera={{ position: [7.5, 6.2, 9], fov: 35 }} dpr={[1, 1.75]} gl={{ preserveDrawingBuffer: true }}>
      <color attach="background" args={[settings.backgroundColor]} />
      <fog attach="fog" args={[settings.backgroundColor, 14, 36]} />
      <ambientLight intensity={0.65} />
      <directionalLight position={[5, 9, 4]} intensity={2.2} castShadow={settings.shadows} shadow-mapSize={[1024, 1024]} />
      <pointLight position={[-4, 4, -2]} color="#ff8a3c" intensity={14} distance={14} />
      <Suspense fallback={null}><Environment preset={settings.environment} environmentIntensity={0.62} /></Suspense>
      <Suspense fallback={null}><SceneGraph /></Suspense>
      <Grid infiniteGrid cellSize={settings.gridSize} sectionSize={settings.gridSize * 4} cellColor="#3a3b35" sectionColor="#55564e" fadeDistance={24} fadeStrength={1} position={[0, -0.01, 0]} />
      <CameraBridge />
      <RenderBridge />
    </Canvas>
  );
}
