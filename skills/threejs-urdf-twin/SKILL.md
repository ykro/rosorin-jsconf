---
name: threejs-urdf-twin
description: Use when building a 60 FPS 3D Digital Twin in Three.js from manufacturer URDF/STL CAD meshes — fixing inverted STL normals (DoubleSide + computeVertexNormals), nested kinematic joint chains (J1..J5 + parallel gripper), and real-time 20 Hz WebSocket servo interpolation.
---

# Three.js URDF/STL Digital Twin for Robotics (`threejs-urdf-twin`)

## Overview

When rendering manufacturer CAD `.stl` meshes from a ROS 2 URDF package inside a browser with Three.js, raw meshes frequently appear transparent or inside-out due to mirrored CAD exports and Z-up vs Y-up coordinate frames. This skill codifies the exact patterns used in `web/src/components/Rosorin3DViewer.tsx` to build a 60 FPS interactive 3D digital twin synchronized over WebSocket (`20 Hz`) with a `40 Hz` Rust kinematics bridge.

## 1. Fixing Transparent / Inside-Out CAD `.stl` Meshes

Manufacturer `.stl` exports (such as `r_in_link.STL`, `r_out_link.STL`, and wheel assemblies) often have inconsistent face winding or uncomputed normals:
1. Always call `geometry.computeVertexNormals()` immediately after `STLLoader.parse()`.
2. Always set `side: THREE.DoubleSide`, `transparent: false`, `opacity: 1.0`, `depthWrite: true`, and `depthTest: true` on every `THREE.MeshStandardMaterial`.
3. Never rely on single-sided back-face culling (`THREE.FrontSide`) for raw robotics CAD files.

```typescript
const geometry = loader.parse(buffer);
geometry.computeVertexNormals();

const material = new THREE.MeshStandardMaterial({
  color: 0x242933,
  metalness: 0.35,
  roughness: 0.45,
  side: THREE.DoubleSide,
  transparent: false,
  opacity: 1.0,
  depthWrite: true,
});
```

## 2. Kinematic Chain Hierarchy (`J1..J5` + Gripper `ID 10`)

Instead of recalculating world matrices manually, mirror the URDF parent-child tree using nested `THREE.Group` pivot nodes so each servo pulse (`120..880`, center `500`) rotates only its local axis:

```typescript
const pulseToRad = (pulse: number, invert = false): number => {
  const clamped = Math.max(120, Math.min(880, pulse));
  const deg = ((clamped - 500) / 380) * 90;
  return ((invert ? -deg : deg) * Math.PI) / 180;
};

j1Pivot.rotation.z = pulseToRad(servos[1] ?? 500);
j2Pivot.rotation.y = pulseToRad(servos[2] ?? 430, true);
j3Pivot.rotation.y = pulseToRad(servos[3] ?? 310);
j4Pivot.rotation.y = pulseToRad(servos[4] ?? 380);
j5Pivot.rotation.z = pulseToRad(servos[5] ?? 500);
```

## 3. Dual-Backend Parity (`--backend mock` vs `--backend ros2`)

- Keep interpolation in the Rust bridge (`40 Hz` tick, `900.0 * dt_s` pulses/s) rather than in CSS transitions.
- Broadcast the interpolated `TelemetryState` over WebSocket at `20 Hz` so the 3D model moves identically whether connected to the laptop simulator (`--backend mock`) or the physical robot (`--backend ros2`).
