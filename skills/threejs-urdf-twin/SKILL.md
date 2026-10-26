---
name: threejs-urdf-twin
description: Use when building a 60 FPS 3D Digital Twin in Three.js from manufacturer URDF/STL CAD meshes — fixing inverted STL normals (DoubleSide + computeVertexNormals), nested kinematic joint chains (J1..J5 + parallel gripper), and real-time 20 Hz WebSocket servo interpolation.
---

# Three.js URDF/STL Digital Twin for Robotics (`threejs-urdf-twin`)

## Overview

When rendering manufacturer CAD `.stl` meshes from a ROS 2 URDF package inside a browser with Three.js, raw meshes frequently appear transparent or inside-out due to mirrored CAD exports and Z-up vs Y-up coordinate frames. This skill codifies the exact patterns used in `web/src/components/Rosorin3DViewer.tsx` to build a 60 FPS interactive 3D digital twin synchronized over WebSocket (`20 Hz`) with a `40 Hz` Rust kinematics bridge.

## 1. Fixing Transparent / Inside-Out CAD `.stl` Meshes

Manufacturer `.stl` exports (such as `r_in_link.stl`, `r_out_link.stl`, `l_in_link.stl`, `l_out_link.stl`, and chassis assemblies) often have inconsistent face winding or uncomputed normals:
1. Always call `geometry.computeVertexNormals()` immediately inside the `STLLoader.load()` callback.
2. Always set `side: THREE.DoubleSide` on every `THREE.MeshStandardMaterial` and attach subtle edge lines (`THREE.EdgesGeometry(geometry, 35)`) for crisp industrial silhouette definition.
3. Rotate the root ROS coordinate group by `rosWorld.rotation.x = -Math.PI / 2` so ROS standard coordinates (`+X` forward, `+Y` left, `+Z` up) map cleanly onto Three.js Y-up space.

```typescript
loader.load(item.url, (geometry) => {
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, item.mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const edges = new THREE.EdgesGeometry(geometry, 35);
  const lines = new THREE.LineSegments(edges, solidEdgeMat);
  mesh.add(lines);

  item.target.add(mesh);
});
```

## 2. Exact URDF Kinematic Chain & `pulseToRadians` (`web/src/components/Rosorin3DViewer.tsx`)

Instead of recalculating world matrices manually, mirror the exact URDF `xyz`, `rpy` (`ZYX` intrinsic order), and rotation `axis` using `createUrdfJoint`:

```typescript
interface JointNode {
  pivot: THREE.Group;
  axis: THREE.Vector3;
  currentAngle: number;
}

function createUrdfJoint(
  parent: THREE.Object3D,
  xyz: [number, number, number],
  rpy: [number, number, number],
  axis: [number, number, number]
): JointNode {
  const originGroup = new THREE.Group();
  originGroup.position.set(xyz[0], xyz[1], xyz[2]);
  originGroup.rotation.set(rpy[0], rpy[1], rpy[2], 'ZYX');
  parent.add(originGroup);

  const pivot = new THREE.Group();
  originGroup.add(pivot);

  return {
    pivot,
    axis: new THREE.Vector3(axis[0], axis[1], axis[2]).normalize(),
    currentAngle: 0,
  };
}

function pulseToRadians(id: number, pulse: number): number {
  const scale = (240 * Math.PI) / 180 / 1000;
  if (id === 10) {
    // Parallel gripper: 220 = wide open (+0.18 rad), 680 = pinched shut (-0.50 rad)
    return 0.18 - ((pulse - 220) / 460) * 0.68;
  }
  if (id === 2 || id === 3 || id === 4) {
    return (500 - pulse) * scale;
  }
  return (pulse - 500) * scale;
}
```

### Symmetric 4-Bar Parallel Linkage for Gripper (`Servo ID 10`)

In the animation loop (`60 FPS`), damp each joint angle toward its target (`0.2` factor) and drive all 6 linkage pivots of the parallel gripper (`rJoint`, `rInJoint`, `rOutJoint`, `lJoint`, `lInJoint`, `lOutJoint`) from `pulseToRadians(10, p10)` so both claws stay parallel as they open (`220`) and close (`680`):

```typescript
const gRad = pulseToRadians(10, p10);
rJoint.currentAngle += (gRad - rJoint.currentAngle) * 0.25;
const openAngle = rJoint.currentAngle;
rJoint.pivot.setRotationFromAxisAngle(rJoint.axis, openAngle);
rInJoint.pivot.setRotationFromAxisAngle(rInJoint.axis, openAngle);
rOutJoint.pivot.setRotationFromAxisAngle(rOutJoint.axis, -openAngle);

lJoint.pivot.setRotationFromAxisAngle(lJoint.axis, openAngle);
lInJoint.pivot.setRotationFromAxisAngle(lInJoint.axis, -openAngle);
lOutJoint.pivot.setRotationFromAxisAngle(lOutJoint.axis, openAngle);
```

## 3. Dual-Backend Parity (`--backend mock` vs `--backend ros2`)

- Keep physical trajectory interpolation in the Rust bridge (`40 Hz` tick, `900.0 * dt_s` pulses/s, `Arc<Mutex<TelemetryState>>`) and apply visual damping in `requestAnimationFrame` (`60 FPS`).
- Broadcast `TelemetryState` over WebSocket at `20 Hz` (`ws://<host>:9000/ws`) so the 3D model moves identically whether connected to the laptop simulator (`--backend mock`) or the physical robot (`--backend ros2` / `--backend serial`).
