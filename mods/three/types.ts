import { registerType } from '@treenx/core/comp';

/** @title 3D Scene — root container for the Three.js viewport */
export class T3dScene {}

/** @title 3D Object — spatial entity in the scene graph */
export class T3dObject {
  /** @title Position X */ px = 0;
  /** @title Position Y */ py = 0;
  /** @title Position Z */ pz = 0;
  /** @title Rotation X (rad) */ rx = 0;
  /** @title Rotation Y (rad) */ ry = 0;
  /** @title Rotation Z (rad) */ rz = 0;
  /** @title Scale X */ sx = 1;
  /** @title Scale Y */ sy = 1;
  /** @title Scale Z */ sz = 1;
}

// --- Geometry ---

/** @title 3D Mesh — geometry shape */
export class T3dMesh {
  /** @title Geometry */ geometry: 'box' | 'sphere' | 'plane' | 'cylinder' | 'torus' | 'cone' | 'capsule' | 'ring' | 'dodecahedron' | 'icosahedron' | 'octahedron' = 'box';
  /** @title Width / Radius */ width = 1;
  /** @title Height */ height = 1;
  /** @title Depth */ depth = 1;
  /** @title Segments */ segments = 32;
  /** @title Cast Shadow */ castShadow = true;
  /** @title Receive Shadow */ receiveShadow = true;
}

// --- Material ---

/** @title 3D Material — surface appearance */
export class T3dMaterial {
  /** @title Type */ kind: 'standard' | 'physical' | 'basic' | 'phong' | 'toon' | 'lambert' = 'standard';
  /** @title Color */ color = '#6366f1';
  /** @title Emissive Color */ emissive = '#000000';
  /** @title Emissive Intensity */ emissiveIntensity = 0;
  /** @title Metalness */ metalness = 0;
  /** @title Roughness */ roughness = 0.5;
  /** @title Opacity */ opacity = 1;
  /** @title Transparent */ transparent = false;
  /** @title Wireframe */ wireframe = false;
  /** @title Side */ side: 'front' | 'back' | 'double' = 'front';
  /** @title Flat Shading */ flatShading = false;
  /** @title Texture URL */ map = '';
  /** @title Normal Map URL */ normalMap = '';
  /** @title Roughness Map URL */ roughnessMap = '';
  /** @title Metalness Map URL */ metalnessMap = '';
  /** @title Emissive Map URL */ emissiveMap = '';
  /** @title AO Map URL */ aoMap = '';
  /** @title Env Map Intensity */ envMapIntensity = 1;
}

// --- Lighting ---

/** @title 3D Light — light source */
export class T3dLight {
  /** @title Kind */ kind: 'point' | 'directional' | 'spot' | 'ambient' | 'hemisphere' | 'rect-area' = 'point';
  /** @title Color */ color = '#ffffff';
  /** @title Ground Color (hemisphere) */ groundColor = '#444444';
  /** @title Intensity */ intensity = 1;
  /** @title Distance (0=infinite) */ distance = 0;
  /** @title Decay */ decay = 2;
  /** @title Cast Shadow */ castShadow = true;
  /** @title Spot Angle */ angle = 0.5;
  /** @title Spot Penumbra */ penumbra = 0.5;
  /** @title Shadow Map Size */ shadowMapSize = 1024;
  /** @title Rect Width */ rectWidth = 1;
  /** @title Rect Height */ rectHeight = 1;
}

// --- Camera ---

/** @title 3D Camera */
export class T3dCamera {
  /** @title Kind */ kind: 'perspective' | 'orthographic' = 'perspective';
  /** @title FOV */ fov = 75;
  /** @title Near Clip */ near = 0.1;
  /** @title Far Clip */ far = 1000;
  /** @title Ortho Size */ orthoSize = 10;
  /** @title Active */ active = true;
}

// --- Physics ---

/** @title 3D Rigidbody — physics body */
export class T3dRigidbody {
  /** @title Kind */ kind: 'dynamic' | 'static' | 'kinematic' = 'dynamic';
  /** @title Mass */ mass = 1;
  /** @title Linear Drag */ linearDamping = 0;
  /** @title Angular Drag */ angularDamping = 0.05;
  /** @title Use Gravity */ useGravity = true;
  /** @title Freeze Position X */ freezePx = false;
  /** @title Freeze Position Y */ freezePy = false;
  /** @title Freeze Position Z */ freezePz = false;
  /** @title Freeze Rotation X */ freezeRx = false;
  /** @title Freeze Rotation Y */ freezeRy = false;
  /** @title Freeze Rotation Z */ freezeRz = false;
}

/** @title 3D Collider — collision shape */
export class T3dCollider {
  /** @title Shape */ shape: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'mesh' | 'convex' = 'box';
  /** @title Is Trigger */ isTrigger = false;
  /** @title Size X */ sizeX = 1;
  /** @title Size Y */ sizeY = 1;
  /** @title Size Z */ sizeZ = 1;
  /** @title Radius */ radius = 0.5;
  /** @title Offset X */ offsetX = 0;
  /** @title Offset Y */ offsetY = 0;
  /** @title Offset Z */ offsetZ = 0;
  /** @title Friction */ friction = 0.5;
  /** @title Restitution (bounce) */ restitution = 0;
}

// --- Audio ---

/** @title 3D Audio — positional sound */
export class T3dAudio {
  /** @title Source URL */ src = '';
  /** @title Volume */ volume = 1;
  /** @title Loop */ loop = false;
  /** @title Autoplay */ autoplay = false;
  /** @title Spatial */ spatial = true;
  /** @title Ref Distance */ refDistance = 1;
  /** @title Max Distance */ maxDistance = 100;
  /** @title Rolloff Factor */ rolloffFactor = 1;
}

// --- Particles ---

/** @title 3D Particles — particle emitter */
export class T3dParticles {
  /** @title Count */ count = 100;
  /** @title Size */ size = 0.1;
  /** @title Color */ color = '#ffffff';
  /** @title Lifetime (s) */ lifetime = 2;
  /** @title Speed */ speed = 1;
  /** @title Spread */ spread = 1;
  /** @title Shape */ shape: 'sphere' | 'cone' | 'box' | 'point' = 'sphere';
  /** @title Emitter */ emitter: 'point' | 'volume' = 'point';
  /** @title Particle Shape */ particleShape: 'sphere' | 'triangle' | 'plane' = 'sphere';
  /** @title Gravity */ gravity = 0;
  /** @title Size Over Lifetime */ sizeOverLifetime = false;
  /** @title Opacity Over Lifetime */ opacityOverLifetime = true;
  /** @title Emissive */ emissive = false;
  /** @title Loop */ loop = true;
}

// --- Text ---

/** @title 3D Text — floating text in scene */
export class T3dText {
  /** @title Text @format textarea */ text = 'Hello';
  /** @title Font Size */ fontSize = 1;
  /** @title Color */ color = '#ffffff';
  /** @title Max Width */ maxWidth = 10;
  /** @title Align */ align: 'left' | 'center' | 'right' = 'center';
  /** @title Anchor X */ anchorX: 'left' | 'center' | 'right' = 'center';
  /** @title Anchor Y */ anchorY: 'top' | 'middle' | 'bottom' = 'middle';
  /** @title Billboard (face camera) */ billboard = false;
  /** @title Outline Width */ outlineWidth = 0;
  /** @title Outline Color */ outlineColor = '#000000';
}

// --- Animation ---

/** @title 3D Animator — animation state */
export class T3dAnimator {
  /** @title GLTF URL */ src = '';
  /** @title Current Clip */ clip = '';
  /** @title Playing */ playing = true;
  /** @title Loop */ loop = true;
  /** @title Speed */ speed = 1;
  /** @title Crossfade Duration (s) */ crossfadeDuration = 0.3;
}

// --- LOD ---

/** @title 3D LOD — level of detail */
export class T3dLod {
  /** @title Distance 0 (high) */ d0 = 0;
  /** @title Distance 1 (mid) */ d1 = 10;
  /** @title Distance 2 (low) */ d2 = 25;
}

// --- Trail ---

/** @title 3D Trail — trail renderer behind moving objects */
export class T3dTrail {
  /** @title Width */ width = 0.2;
  /** @title Length (s) */ length = 1;
  /** @title Color Start */ colorStart = '#ffffff';
  /** @title Color End */ colorEnd = '#ffffff00';
  /** @title Attenuation */ attenuation: 'linear' | 'squared' | 'none' = 'linear';
}

// --- Line ---

/** @title 3D Line Renderer */
export class T3dLine {
  /** @title Color */ color = '#ffffff';
  /** @title Line Width */ lineWidth = 1;
  /** @title Dashed */ dashed = false;
  /** @title Dash Size */ dashSize = 0.1;
  /** @title Gap Size */ gapSize = 0.05;
  /** @title Points (JSON array of [x,y,z]) @format textarea */ points = '[[0,0,0],[1,1,0],[2,0,0]]';
}

// --- Script ---

/** @title 3D Script — client-side update loop */
export class T3dScript {
  /** @title Code @format textarea */
  code = '';
  /** @title Active */ active = true;
}

// --- Register all ---

registerType('t3d.scene', T3dScene);
registerType('t3d.object', T3dObject);
registerType('t3d.mesh', T3dMesh);
registerType('t3d.material', T3dMaterial);
registerType('t3d.light', T3dLight);
registerType('t3d.camera', T3dCamera);
registerType('t3d.rigidbody', T3dRigidbody);
registerType('t3d.collider', T3dCollider);
registerType('t3d.audio', T3dAudio);
registerType('t3d.particles', T3dParticles);
registerType('t3d.text', T3dText);
registerType('t3d.animator', T3dAnimator);
registerType('t3d.lod', T3dLod);
registerType('t3d.trail', T3dTrail);
registerType('t3d.line', T3dLine);
registerType('t3d.script', T3dScript);
