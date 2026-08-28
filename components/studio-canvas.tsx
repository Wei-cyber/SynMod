'use client';

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Edges, Grid, OrbitControls, TransformControls, useGLTF } from '@react-three/drei';
import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import {
  Box3,
  DoubleSide,
  Group,
  MathUtils,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import { setSceneRoot } from '@/lib/scene-runtime';
import { useStudioStore } from '@/lib/studio-store';
import type { StudioObject, Vec3 } from '@/lib/studio-types';

function Geometry({ type }: { type: StudioObject['type'] }) {
  if (type === 'box') return <boxGeometry args={[1, 1, 1]} />;
  if (type === 'sphere') return <sphereGeometry args={[0.5, 32, 24]} />;
  if (type === 'cylinder') return <cylinderGeometry args={[0.5, 0.5, 1, 32]} />;
  if (type === 'cone') return <coneGeometry args={[0.5, 1, 32]} />;
  return <torusGeometry args={[0.5, 0.15, 18, 48]} />;
}

function ImportedAsset({ dataUrl }: { dataUrl: string }) {
  const { scene } = useGLTF(dataUrl);
  const clone = useMemo(() => scene.clone(true), [scene]);
  return <primitive object={clone} />;
}

function PrimitiveMesh({ object, selected, pulsing }: { object: StudioObject; selected: boolean; pulsing: boolean }) {
  const materialRef = useRef<MeshStandardMaterial>(null);
  const pulseStarted = useRef(Date.now());
  useEffect(() => { if (pulsing) pulseStarted.current = Date.now(); }, [pulsing]);
  useFrame(() => {
    if (!materialRef.current) return;
    const elapsed = Date.now() - pulseStarted.current;
    materialRef.current.emissiveIntensity = pulsing && elapsed < 1_100 ? Math.max(0, 1 - elapsed / 1_100) * 0.8 : selected ? 0.14 : 0;
  });

  if (object.type === 'glb') {
    return (
      <Suspense fallback={null}>
        <ImportedAsset dataUrl={object.assetDataUrl!} />
      </Suspense>
    );
  }

  if (object.type === 'group') return null;
  return (
    <mesh castShadow receiveShadow>
      <Geometry type={object.type} />
      <meshStandardMaterial
        ref={materialRef}
        color={object.material.color}
        roughness={object.material.roughness}
        metalness={object.material.metalness}
        wireframe={object.material.wireframe}
        emissive="#f15722"
        emissiveIntensity={selected ? 0.14 : 0}
        side={object.type === 'cone' ? DoubleSide : undefined}
      />
      {selected && <Edges color="#ff7137" threshold={12} />}
    </mesh>
  );
}

function SceneNode({ object, objects }: { object: StudioObject; objects: StudioObject[] }) {
  const nodeRef = useRef<Group>(null);
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
    const node = nodeRef.current;
    if (!node) return;
    execute({
      type: 'set_transform',
      objectId: object.id,
      position: node.position.toArray() as Vec3,
      rotation: [MathUtils.radToDeg(node.rotation.x), MathUtils.radToDeg(node.rotation.y), MathUtils.radToDeg(node.rotation.z)],
      scale: node.scale.toArray() as Vec3,
    });
  };

  return (
    <>
      <group
        ref={nodeRef}
        name={`model-object-${object.id}`}
        position={object.position}
        rotation={object.rotation.map(MathUtils.degToRad) as Vec3}
        scale={object.scale}
        onClick={onClick}
      >
        <PrimitiveMesh object={object} selected={selection.includes(object.id)} pulsing={pulsing} />
        {children.map((child) => <SceneNode key={child.id} object={child} objects={objects} />)}
      </group>
      {selected && nodeRef.current && (
        <TransformControls
          object={nodeRef.current}
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
  const gridSize = useStudioStore((state) => state.doc.settings.gridSize);
  return (
    <Canvas shadows camera={{ position: [7.5, 6.2, 9], fov: 35 }} dpr={[1, 1.75]}>
      <color attach="background" args={['#20211d']} />
      <fog attach="fog" args={['#20211d', 14, 36]} />
      <ambientLight intensity={0.9} />
      <directionalLight position={[5, 9, 4]} intensity={2.4} castShadow shadow-mapSize={[1024, 1024]} />
      <pointLight position={[-4, 4, -2]} color="#ff8a3c" intensity={18} distance={14} />
      <Suspense fallback={null}><SceneGraph /></Suspense>
      <Grid infiniteGrid cellSize={gridSize} sectionSize={gridSize * 4} cellColor="#3a3b35" sectionColor="#55564e" fadeDistance={24} fadeStrength={1} position={[0, -0.01, 0]} />
      <CameraBridge />
    </Canvas>
  );
}
