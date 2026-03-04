import { type NodeData } from '@treenity/core/core';
import { registerPrefab } from '@treenity/core/mod';

registerPrefab('three', 'seed', [
  { $path: 'demo', $type: 'dir' },
  { $path: 'demo/three', $type: 'dir' },
  { $path: 'demo/three/scene', $type: 't3d.scene' },

  // Ground plane
  { $path: 'demo/three/scene/ground', $type: 't3d.object',
    px: 0, py: -0.5, pz: 0, rx: -Math.PI / 2, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
    mesh: { $type: 't3d.mesh', geometry: 'plane', width: 10, depth: 10, color: '#334155', roughness: 0.9, receiveShadow: true, castShadow: false },
  },

  // Spinning cube
  { $path: 'demo/three/scene/cube', $type: 't3d.object',
    px: 0, py: 0.5, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
    mesh: { $type: 't3d.mesh', geometry: 'box', color: '#6366f1' },
    script: { $type: 't3d.script', code: 'ctx.ref.rotation.y += ctx.dt;', active: true },
  },

  // Metallic sphere
  { $path: 'demo/three/scene/sphere', $type: 't3d.object',
    px: 2, py: 0.5, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
    mesh: { $type: 't3d.mesh', geometry: 'sphere', width: 0.5, color: '#f59e0b', metalness: 0.8, roughness: 0.2 },
  },

  // Directional light (sun)
  { $path: 'demo/three/scene/sun', $type: 't3d.object',
    px: 5, py: 10, pz: 5, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
    light: { $type: 't3d.light', kind: 'directional', intensity: 1.5, castShadow: true },
  },

  // Ambient fill
  { $path: 'demo/three/scene/ambient', $type: 't3d.object',
    px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
    light: { $type: 't3d.light', kind: 'ambient', intensity: 0.3 },
  },

  // Nested group
  { $path: 'demo/three/scene/group', $type: 't3d.object',
    px: -2, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },

  { $path: 'demo/three/scene/group/torus', $type: 't3d.object',
    px: 0, py: 0.5, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
    mesh: { $type: 't3d.mesh', geometry: 'torus', width: 0.4, color: '#ec4899' },
    script: { $type: 't3d.script', code: 'ctx.ref.rotation.x += ctx.dt * 0.7;', active: true },
  },

  { $path: 'demo/three/scene/group/cone', $type: 't3d.object',
    px: 0, py: 1.5, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
    mesh: { $type: 't3d.mesh', geometry: 'cone', width: 0.3, height: 0.6, color: '#10b981' },
  },
] as NodeData[]);
