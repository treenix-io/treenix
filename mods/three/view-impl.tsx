// Three.js scene view — renders Treenix node tree as a 3D scene graph
// SceneView registered for t3d.scene in "react" context

import { Billboard, OrbitControls, Text, Trail } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { getComponent, type NodeData } from '@treenx/core';
import { useResolvedNode } from '@treenx/react/bind/hook';
import { cache } from '@treenx/react';
import { type View, useCurrentNode } from '@treenx/react';
import { execute, useChildren, usePath } from '@treenx/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  T3dCamera,
  T3dLight,
  T3dLine,
  T3dMaterial,
  T3dMesh,
  T3dObject,
  T3dParticles,
  T3dScene,
  T3dScript,
  T3dText,
  T3dTrail,
} from './types';

// --- Texture loader helper ---

function useOptionalTexture(url: string | undefined): THREE.Texture | undefined {
  const [tex, setTex] = useState<THREE.Texture | undefined>();
  useEffect(() => {
    if (!url) { setTex(undefined); return; }
    new THREE.TextureLoader().load(url, setTex, undefined, () => setTex(undefined));
  }, [url]);
  return tex;
}

// --- Geometry ---

function Geometry({ mesh }: { mesh: T3dMesh }) {
  const s = mesh.segments;
  switch (mesh.geometry) {
    case 'sphere':
      return <sphereGeometry args={[mesh.width, s, s]} />;
    case 'plane':
      return <planeGeometry args={[mesh.width, mesh.depth]} />;
    case 'cylinder':
      return <cylinderGeometry args={[mesh.width, mesh.width, mesh.height, s]} />;
    case 'torus':
      return <torusGeometry args={[mesh.width, mesh.width * 0.4, 16, s]} />;
    case 'cone':
      return <coneGeometry args={[mesh.width, mesh.height, s]} />;
    case 'capsule':
      return <capsuleGeometry args={[mesh.width, mesh.height, 16, s]} />;
    case 'ring':
      return <ringGeometry args={[mesh.width * 0.5, mesh.width, s]} />;
    case 'dodecahedron':
      return <dodecahedronGeometry args={[mesh.width]} />;
    case 'icosahedron':
      return <icosahedronGeometry args={[mesh.width]} />;
    case 'octahedron':
      return <octahedronGeometry args={[mesh.width]} />;
    default: // box
      return <boxGeometry args={[mesh.width, mesh.height, mesh.depth]} />;
  }
}

// --- Material ---

const SIDE_MAP = { front: THREE.FrontSide, back: THREE.BackSide, double: THREE.DoubleSide } as const;

function MaterialElement({ data }: { data: T3dMaterial }) {
  const map = useOptionalTexture(data.map || undefined);
  const normalMap = useOptionalTexture(data.normalMap || undefined);
  const roughnessMap = useOptionalTexture(data.roughnessMap || undefined);
  const metalnessMap = useOptionalTexture(data.metalnessMap || undefined);
  const emissiveMap = useOptionalTexture(data.emissiveMap || undefined);
  const aoMap = useOptionalTexture(data.aoMap || undefined);

  const side = SIDE_MAP[data.side] ?? THREE.FrontSide;

  switch (data.kind) {
    case 'basic':
      return <meshBasicMaterial color={data.color} map={map} wireframe={data.wireframe} transparent={data.transparent} opacity={data.opacity} side={side} />;
    case 'phong':
      return <meshPhongMaterial color={data.color} emissive={data.emissive} map={map} normalMap={normalMap} wireframe={data.wireframe} flatShading={data.flatShading} transparent={data.transparent} opacity={data.opacity} side={side} />;
    case 'toon':
      return <meshToonMaterial color={data.color} map={map} wireframe={data.wireframe} transparent={data.transparent} opacity={data.opacity} side={side} />;
    case 'lambert':
      return <meshLambertMaterial color={data.color} emissive={data.emissive} map={map} wireframe={data.wireframe} transparent={data.transparent} opacity={data.opacity} side={side} />;
    case 'physical':
      return (
        <meshPhysicalMaterial
          color={data.color} emissive={data.emissive} emissiveIntensity={data.emissiveIntensity}
          metalness={data.metalness} roughness={data.roughness}
          map={map} normalMap={normalMap} roughnessMap={roughnessMap} metalnessMap={metalnessMap} emissiveMap={emissiveMap} aoMap={aoMap}
          wireframe={data.wireframe} flatShading={data.flatShading} transparent={data.transparent} opacity={data.opacity} side={side}
          envMapIntensity={data.envMapIntensity}
        />
      );
    default: // standard
      return (
        <meshStandardMaterial
          color={data.color} emissive={data.emissive} emissiveIntensity={data.emissiveIntensity}
          metalness={data.metalness} roughness={data.roughness}
          map={map} normalMap={normalMap} roughnessMap={roughnessMap} metalnessMap={metalnessMap} emissiveMap={emissiveMap} aoMap={aoMap}
          wireframe={data.wireframe} flatShading={data.flatShading} transparent={data.transparent} opacity={data.opacity} side={side}
          envMapIntensity={data.envMapIntensity}
        />
      );
  }
}

function MeshElement({ mesh, material }: { mesh: T3dMesh; material: T3dMaterial | null }) {
  return (
    <mesh castShadow={mesh.castShadow} receiveShadow={mesh.receiveShadow}>
      <Geometry mesh={mesh} />
      {material
        ? <MaterialElement data={material} />
        : <meshStandardMaterial color="#6366f1" roughness={0.5} />
      }
    </mesh>
  );
}

// --- Light ---

function LightElement({ data }: { data: T3dLight }) {
  switch (data.kind) {
    case 'directional':
      return <directionalLight color={data.color} intensity={data.intensity} castShadow={data.castShadow} />;
    case 'spot':
      return (
        <spotLight
          color={data.color} intensity={data.intensity}
          angle={data.angle} penumbra={data.penumbra} distance={data.distance} decay={data.decay}
          castShadow={data.castShadow}
        />
      );
    case 'ambient':
      return <ambientLight color={data.color} intensity={data.intensity} />;
    case 'hemisphere':
      return <hemisphereLight color={data.color} groundColor={data.groundColor} intensity={data.intensity} />;
    case 'rect-area':
      return <rectAreaLight color={data.color} intensity={data.intensity} width={data.rectWidth} height={data.rectHeight} />;
    default: // point
      return <pointLight color={data.color} intensity={data.intensity} distance={data.distance} decay={data.decay} castShadow={data.castShadow} />;
  }
}

// --- Text ---

function TextElement({ data }: { data: T3dText }) {
  const inner = (
    <Text
      fontSize={data.fontSize}
      color={data.color}
      maxWidth={data.maxWidth}
      textAlign={data.align}
      anchorX={data.anchorX}
      anchorY={data.anchorY}
      outlineWidth={data.outlineWidth}
      outlineColor={data.outlineColor}
    >
      {data.text}
    </Text>
  );

  return data.billboard ? <Billboard>{inner}</Billboard> : inner;
}

// --- Particles ---

function ParticlesElement({ data }: { data: T3dParticles }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const isVolume = data.emitter === 'volume';

  // Per-particle state: position, drift velocity, rotation speed
  const state = useMemo(() => {
    const pos = new Float32Array(data.count * 3);
    const vel = new Float32Array(data.count * 3);
    const rot = new Float32Array(data.count * 3);

    for (let i = 0; i < data.count; i++) {
      const i3 = i * 3;
      if (isVolume) {
        pos[i3]     = (Math.random() - 0.5) * data.spread * 2;
        pos[i3 + 1] = Math.random() * data.spread;
        pos[i3 + 2] = (Math.random() - 0.5) * data.spread * 2;
        vel[i3]     = (Math.random() - 0.5) * 0.3;
        vel[i3 + 1] = 0;
        vel[i3 + 2] = (Math.random() - 0.5) * 0.3;
      } else {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        vel[i3]     = Math.sin(phi) * Math.cos(theta) * data.spread;
        vel[i3 + 1] = Math.sin(phi) * Math.sin(theta) * data.spread;
        vel[i3 + 2] = Math.cos(phi) * data.spread;
      }
      rot[i3]     = (Math.random() - 0.5) * 4;
      rot[i3 + 1] = (Math.random() - 0.5) * 4;
      rot[i3 + 2] = (Math.random() - 0.5) * 4;
    }
    return { pos, vel, rot };
  }, [data.count, data.spread, isVolume]);

  const ages = useMemo(() => {
    const a = new Float32Array(data.count);
    for (let i = 0; i < data.count; i++) a[i] = Math.random() * data.lifetime;
    return a;
  }, [data.count, data.lifetime]);

  useFrame((_, dt) => {
    if (!meshRef.current) return;
    const { pos, vel, rot } = state;

    for (let i = 0; i < data.count; i++) {
      ages[i] += dt;
      const i3 = i * 3;

      if (ages[i] > data.lifetime) {
        ages[i] = 0;
        if (isVolume) {
          pos[i3]     = (Math.random() - 0.5) * data.spread * 2;
          pos[i3 + 1] = Math.random() * data.spread;
          pos[i3 + 2] = (Math.random() - 0.5) * data.spread * 2;
          vel[i3]     = (Math.random() - 0.5) * 0.3;
          vel[i3 + 2] = (Math.random() - 0.5) * 0.3;
        } else {
          dummy.position.set(0, 0, 0);
        }
      }

      const t = ages[i];

      if (isVolume) {
        // Gentle fall with horizontal wobble
        dummy.position.set(
          pos[i3]     + vel[i3] * t + Math.sin(t * 2 + i) * 0.2,
          pos[i3 + 1] - data.gravity * t * data.speed,
          pos[i3 + 2] + vel[i3 + 2] * t + Math.cos(t * 1.5 + i * 0.7) * 0.15,
        );
        dummy.rotation.set(rot[i3] * t, rot[i3 + 1] * t, rot[i3 + 2] * t);
      } else {
        dummy.position.set(
          vel[i3] * t * data.speed,
          vel[i3 + 1] * t * data.speed - data.gravity * t * t * 0.5,
          vel[i3 + 2] * t * data.speed,
        );
      }

      const lifeRatio = ages[i] / data.lifetime;
      const s = data.sizeOverLifetime ? data.size * (1 - lifeRatio) : data.size;
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  // circleGeometry(r, 3) = equilateral triangle
  const geometry = data.particleShape === 'triangle'
    ? <circleGeometry args={[1, 3]} />
    : data.particleShape === 'plane'
      ? <planeGeometry args={[1, 1]} />
      : <sphereGeometry args={[1, 8, 8]} />;

  const side = data.particleShape !== 'sphere' ? THREE.DoubleSide : undefined;

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, data.count]}>
      {geometry}
      {data.emissive
        ? <meshBasicMaterial color={data.color} transparent opacity={data.opacityOverLifetime ? 0.8 : 1} side={side} />
        : <meshStandardMaterial color={data.color} transparent opacity={data.opacityOverLifetime ? 0.8 : 1} side={side} />
      }
    </instancedMesh>
  );
}

// --- Line ---

function LineElement({ data }: { data: T3dLine }) {
  const points = useMemo(() => {
    try {
      const arr = JSON.parse(data.points) as number[][];
      return arr.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    } catch { return [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]; }
  }, [data.points]);

  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints(points), [points]);

  if (data.dashed) {
    return (
      // @ts-expect-error R3F <line> is THREE.Line, not SVG <line>
      <line geometry={geometry}>
        <lineDashedMaterial color={data.color} dashSize={data.dashSize} gapSize={data.gapSize} />
      </line>
    );
  }

  return (
    // @ts-expect-error R3F <line> is THREE.Line, not SVG <line>
    <line geometry={geometry}>
      <lineBasicMaterial color={data.color} />
    </line>
  );
}

// --- Trail ---

function TrailElement({ data, children }: { data: T3dTrail; children: React.ReactNode }) {
  return (
    <Trail
      width={data.width}
      length={data.length}
      color={data.colorStart}
      attenuation={(t: number) => data.attenuation === 'none' ? 1 : data.attenuation === 'squared' ? t * t : t}
    >
      {children}
    </Trail>
  );
}

// --- Script runner (client-side useFrame update loop) ---

function ScriptRunner({ path, code, groupRef }: {
  path: string;
  code: string;
  groupRef: React.RefObject<THREE.Group | null>;
}) {
  const fnRef = useRef<((ctx: unknown) => void) | null>(null);
  const { data: node } = usePath(path);

  useEffect(() => {
    try {
      fnRef.current = new Function('ctx', code) as (ctx: unknown) => void;
    } catch (e) {
      console.error(`[t3d.script] compile error at ${path}:`, e);
      fnRef.current = null;
    }
  }, [code, path]);

  const throttledExecute = useMemo(() => {
    let last = 0;
    return (action: string, data?: unknown) => {
      const now = Date.now();
      if (now - last < 100) return;
      last = now;
      execute(path, action, data);
    };
  }, [path, execute]);

  useFrame((state, dt) => {
    if (!fnRef.current || !node) return;
    try {
      fnRef.current({
        node, dt,
        time: state.clock.elapsedTime,
        ref: groupRef.current,
        execute: throttledExecute,
        getNode: (p: string) => cache.get(p),
        getChildren: (p: string) => cache.getChildren(p),
      });
    } catch (e) {
      console.error(`[t3d.script] runtime error at ${path}:`, e);
      fnRef.current = null;
    }
  });

  return null;
}

// --- Recursive tree node renderer ---

function TreeNode({ path }: { path: string }) {
  const [node] = useResolvedNode(path);
  const { data: children } = useChildren(path);
  const groupRef = useRef<THREE.Group>(null);

  if (!node) return null;

  const obj = getComponent(node, T3dObject);
  const mesh = getComponent(node, T3dMesh);
  const material = getComponent(node, T3dMaterial);
  const light = getComponent(node, T3dLight);
  const camera = getComponent(node, T3dCamera);
  const text = getComponent(node, T3dText);
  const particles = getComponent(node, T3dParticles);
  const line = getComponent(node, T3dLine);
  const trail = getComponent(node, T3dTrail);
  const script = getComponent(node, T3dScript);

  // Build inner visual content
  let visual: React.ReactNode = null;
  if (mesh) visual = <MeshElement mesh={mesh} material={material ?? null} />;
  else if (light) visual = <LightElement data={light} />;
  else if (text) visual = <TextElement data={text} />;
  else if (particles) visual = <ParticlesElement data={particles} />;
  else if (line) visual = <LineElement data={line} />;

  // Wrap in trail if present
  if (trail && visual) visual = <TrailElement data={trail}>{visual}</TrailElement>;

  return (
    <group
      ref={groupRef}
      position={obj ? [obj.px, obj.py, obj.pz] : undefined}
      rotation={obj ? [obj.rx, obj.ry, obj.rz] : undefined}
      scale={obj ? [obj.sx, obj.sy, obj.sz] : undefined}
    >
      {visual}
      {script?.active && script.code && (
        <ScriptRunner path={path} code={script.code} groupRef={groupRef} />
      )}
      {children.map((c) => (
        <TreeNode key={c.$path} path={c.$path} />
      ))}
    </group>
  );
}

// --- Scene root (inside Canvas) ---

function SceneRoot({ path }: { path: string }) {
  const { data: children } = useChildren(path, { watch: true, watchNew: true });

  return (
    <>
      {children.map((c) => (
        <TreeNode key={c.$path} path={c.$path} />
      ))}
    </>
  );
}

// --- Top-level view (registered lazily from ./view.tsx) ---

export const SceneView: View<T3dScene> = ({ ctx }) => {
  const path = ctx!.path;

  return (
    <div className="w-full h-[600px] rounded-lg overflow-hidden bg-black/90">
      <Canvas shadows camera={{ position: [5, 5, 5], fov: 60 }}>
        <OrbitControls />
        <SceneRoot path={path} />
      </Canvas>
    </div>
  );
}
