---
name: threejs-urdf-twin
description: Úsalo al construir un gemelo digital en Three.js a partir de mallas STL de un paquete URDF del fabricante — normales invertidas (DoubleSide + computeVertexNormals), cadena de articulaciones URDF (J1..J5 y pinza paralela), suavizado independiente de los FPS desde telemetría WebSocket a 20 Hz, mallas que no cargan y liberación de recursos.
---

# Gemelo digital en Three.js desde URDF y STL (`threejs-urdf-twin`)

## Resumen

Las mallas `.stl` de un paquete URDF suelen verse transparentes o al revés en el navegador: caras con orientación inconsistente, normales sin calcular y ejes Z-up de ROS contra Y-up de Three.js. Este skill resume cómo lo resuelve `web/src/components/Rosorin3DViewer.tsx`, que dibuja el ROSOrin Pro con 16 mallas y lo mueve con la telemetría que el bridge en Rust manda por WebSocket a 20 Hz.

## 1. Mallas transparentes o al revés

1. Llama a `geometry.computeVertexNormals()` dentro del callback de `STLLoader.load()`.
2. Usa `side: THREE.DoubleSide` en los materiales y agrega aristas (`THREE.EdgesGeometry(geometry, 35)`) para marcar la silueta.
3. Rota el grupo raíz de ROS con `rosWorld.rotation.x = -Math.PI / 2` para que `+X` adelante, `+Y` izquierda, `+Z` arriba quede bien en el espacio Y-up.
4. Maneja el error de carga: si una malla no existe, la UI muestra «No cargó: <archivo>» en lugar de quedarse a medias sin aviso.

Así está en el componente:

```typescript
loader.load(
  item.url,
  (geometry) => {
    if (disposed) {
      geometry.dispose();
      return;
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, item.mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const edges = new THREE.EdgesGeometry(geometry, 35);
    const lines = new THREE.LineSegments(edges, solidEdgeMat);
    mesh.add(lines);

    item.target.add(mesh);
    loadedCount += 1;
    setMeshesLoaded(loadedCount);
  },
  undefined,
  (err) => {
    if (disposed) return;
    const file = item.url.split('/').pop() || item.url;
    console.warn(`[3d] No se pudo cargar la malla ${item.url}:`, err);
    setMeshErrors((prev) => (prev.includes(file) ? prev : [...prev, file]));
  }
);
```

`disposed` evita agregar a una escena ya destruida una malla que terminó de cargar tarde.

Para las sombras usa `THREE.PCFShadowMap`: three 0.186 avisa que `PCFSoftShadowMap` ya no existe.

```typescript
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in three r18x
```

## 2. Cadena URDF y conversión de pulsos

En lugar de calcular matrices a mano, replica el `xyz`, el `rpy` (orden `ZYX`) y el `axis` de cada articulación del URDF:

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

Los servos usan pulsos `0..1000` para `0..240°`, con `500` al centro.

## 3. Suavizado independiente de los FPS

La telemetría llega a 20 Hz y el navegador dibuja a su propia tasa (60, 120 Hz…). Un factor fijo por cuadro (`* 0.2`) haría que el gemelo se mueva más rápido en pantallas de 120 Hz. El componente calcula el factor con el `dt` real del cuadro:

```typescript
const now = performance.now();
const dt = Math.min(0.1, Math.max(0.001, (now - lastFrameTime) / 1000));
lastFrameTime = now;
const lerpAlpha = 1 - Math.exp(-12 * dt);
```

y lo aplica igual a la posición del chasis y a cada articulación:

```typescript
for (const [jn, targetRad] of joints) {
  jn.currentAngle += (targetRad - jn.currentAngle) * lerpAlpha;
  jn.pivot.setRotationFromAxisAngle(jn.axis, jn.currentAngle);
}
```

### Pinza paralela de 4 barras (servo 10)

Las 6 articulaciones de la pinza se mueven desde un solo ángulo para que ambas garras queden paralelas al abrir (220) y cerrar (680):

```typescript
const gRad = pulseToRadians(10, p10);
rJoint.currentAngle += (gRad - rJoint.currentAngle) * lerpAlpha;
const openAngle = rJoint.currentAngle;
rJoint.pivot.setRotationFromAxisAngle(rJoint.axis, openAngle);
rInJoint.pivot.setRotationFromAxisAngle(rInJoint.axis, openAngle);
rOutJoint.pivot.setRotationFromAxisAngle(rOutJoint.axis, -openAngle);

lJoint.pivot.setRotationFromAxisAngle(lJoint.axis, openAngle);
lInJoint.pivot.setRotationFromAxisAngle(lInJoint.axis, -openAngle);
lOutJoint.pivot.setRotationFromAxisAngle(lOutJoint.axis, openAngle);
```

## 4. Liberar recursos

Al desmontar, libera geometrías, materiales, texturas y el renderer. `material.dispose()` no libera las texturas que usa el material, por eso las `CanvasTexture` de las etiquetas se guardan en `labelTextures` y se liberan aparte:

```typescript
return () => {
  disposed = true;
  resizeObserver.disconnect();
  cancelAnimationFrame(animId);
  controls.dispose();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material.dispose();
      }
    }
  });
  for (const tex of labelTextures) tex.dispose();
  renderer.dispose();
};
```

Reutiliza objetos en el loop de animación (por ejemplo un solo `THREE.Color` para el LED) en vez de crear uno por cuadro.

## 5. Misma telemetría para simulador y robot

- La trayectoria de los servos la calcula el bridge en Rust (loop de 40 Hz, cada servo a `|Δ| / duración` pulsos por segundo, recortado a `150..1800`). El navegador solo suaviza.
- La telemetría llega por `ws://<host>:9000/ws?token=<t>` a 20 Hz, igual con `--backend mock` que con `ros2` o `serial`. Los mensajes que traen la clave `event` son errores de comandos, no telemetría.
- **En el bridge, la odometría solo se integra desde la velocidad comandada** (no desde encoders): ningún gesto aplica «saltos» de posición. Los `point_*` (Bug Hunter) se desplazan con su velocidad real.
- Sin bridge, `use-robot-telemetry.ts` simula una telemetría local para que el gemelo siga respondiendo. Ahí los `point_*` tampoco tocan la odometría, pero otros gestos (`wave_hello`, los `bumblebee_*`…) todavía aplican desplazamientos aproximados (`LOCAL_GESTURE_TARGETS`), así que la pose local puede diferir de la del bridge.
