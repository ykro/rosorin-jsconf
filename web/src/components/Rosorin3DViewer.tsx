'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { TelemetryState } from '@/lib/types';
import { shouldIgnoreShortcut } from '@/lib/keyboard';

export type SceneMode = 'sandbox' | 'roaster' | 'gatekeeper' | 'bughunter';
export type StageSceneMode = SceneMode;

export interface Rosorin3DViewerProps {
  telemetry: TelemetryState;
  sceneMode?: SceneMode;
  height?: number;
  heightClass?: string;
  enableKeyboard?: boolean;
  onServoJog?: (id: number, delta: number) => void;
  onJogServo?: (id: number, delta: number) => void;
  onGripperSet?: (open: boolean) => void;
  onChassisMove?: (vx: number, vy: number, wz: number) => void;
  onMoveChassis?: (vx: number, vy: number, wz: number) => void;
  onGestureTrigger?: (gesture: string) => void;
  onTriggerGesture?: (gesture: string) => void;
  onSimulateLidar?: (front_m: number) => void;
  onWebcamFrame?: (jpegBase64: string) => void;
  onResetScene?: () => void;
}

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

export function Rosorin3DViewer({
  telemetry,
  sceneMode = 'sandbox',
  enableKeyboard = true,
  onServoJog,
  onJogServo,
  onGripperSet,
  onChassisMove,
  onMoveChassis,
  onGestureTrigger,
  onTriggerGesture,
  onSimulateLidar,
  onWebcamFrame,
  onResetScene,
}: Rosorin3DViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const telemetryRef = useRef<TelemetryState>(telemetry);
  const [meshesLoaded, setMeshesLoaded] = useState(0);
  const [meshErrors, setMeshErrors] = useState<string[]>([]);
  const [lastKeyPressed, setLastKeyPressed] = useState<string>('');
  const [webcamActive, setWebcamActive] = useState(false);
  const [localLidarM, setLocalLidarM] = useState<number | null>(null);
  const webcamFrameCbRef = useRef(onWebcamFrame);

  const jog = onJogServo ?? onServoJog;
  const move = onMoveChassis ?? onChassisMove;
  const trigger = onTriggerGesture ?? onGestureTrigger;

  useEffect(() => {
    telemetryRef.current = telemetry;
  }, [telemetry]);

  useEffect(() => {
    webcamFrameCbRef.current = onWebcamFrame;
  }, [onWebcamFrame]);

  const effectiveLidarM = localLidarM ?? telemetry.lidar?.front_m ?? 1.42;
  const lidarBlocked = effectiveLidarM < 0.28;

  const handleToggleObstacle = () => {
    const nextDist = lidarBlocked ? 1.42 : 0.16;
    setLocalLidarM(nextDist);
    onSimulateLidar?.(nextDist);
  };

  // Webcam lifecycle (Aurora 930 Pro 3D Camera on the wrist)
  useEffect(() => {
    if (!webcamActive) return;
    const video = videoRef.current;

    let cancelled = false;
    let activeStream: MediaStream | null = null;
    let frameTimer: ReturnType<typeof setInterval> | null = null;

    navigator.mediaDevices
      ?.getUserMedia({ video: { width: 320, height: 240 }, audio: false })
      .then((stream) => {
        if (cancelled || !video) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        activeStream = stream;
        video.srcObject = stream;
        video.play().catch((err) => console.warn('[webcam] play() falló:', err));

        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d');
        frameTimer = setInterval(() => {
          if (!ctx || !webcamFrameCbRef.current) return;
          ctx.drawImage(video, 0, 0, 320, 240);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
          const b64 = dataUrl.split(',')[1];
          if (b64) webcamFrameCbRef.current(b64);
        }, 1000);
      })
      .catch((err) => {
        console.warn('[webcam] No se pudo abrir la cámara:', err);
        setWebcamActive(false);
      });

    return () => {
      cancelled = true;
      if (frameTimer) clearInterval(frameTimer);
      if (activeStream) {
        activeStream.getTracks().forEach((t) => t.stop());
      }
      if (video) {
        video.srcObject = null;
      }
    };
  }, [webcamActive]);

  // Keyboard listener for moving arm, gripper, and chassis
  useEffect(() => {
    if (!enableKeyboard) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (shouldIgnoreShortcut(e)) return;

      const key = e.key.toLowerCase();
      switch (key) {
        case '1':
          setLastKeyPressed('J1 +30');
          jog?.(1, 30);
          break;
        case 'q':
          setLastKeyPressed('J1 -30');
          jog?.(1, -30);
          break;
        case '2':
          setLastKeyPressed('J2 +25');
          jog?.(2, 25);
          break;
        case 'w':
          setLastKeyPressed('J2 -25');
          jog?.(2, -25);
          break;
        case '3':
          setLastKeyPressed('J3 +25');
          jog?.(3, 25);
          break;
        case 'e':
          setLastKeyPressed('J3 -25');
          jog?.(3, -25);
          break;
        case '4':
          setLastKeyPressed('J4 +25');
          jog?.(4, 25);
          break;
        case 'r':
          setLastKeyPressed('J4 -25');
          jog?.(4, -25);
          break;
        case '5':
          setLastKeyPressed('J5 +35');
          jog?.(5, 35);
          break;
        case 't':
          setLastKeyPressed('J5 -35');
          jog?.(5, -35);
          break;
        case 'o': {
          const cur10 = telemetryRef.current.servos?.['10'] ?? 500;
          const target = cur10 <= 250 ? 680 : 220;
          setLastKeyPressed(target === 220 ? 'Pinza Abierta (220)' : 'Pinza Cerrada (680)');
          if (onGripperSet) onGripperSet(target === 220);
          else jog?.(10, target - cur10);
          break;
        }
        case 'c': {
          const cur10 = telemetryRef.current.servos?.['10'] ?? 500;
          const target = cur10 >= 620 ? 220 : 680;
          setLastKeyPressed(target === 680 ? 'Pinza Cerrada (680)' : 'Pinza Abierta (220)');
          if (onGripperSet) onGripperSet(target === 220);
          else jog?.(10, target - cur10);
          break;
        }
        case 'arrowup':
          e.preventDefault();
          if (effectiveLidarM < 0.28) {
            setLastKeyPressed('BLOQUEADO POR LIDAR (<0.28m)');
          } else {
            setLastKeyPressed('Avanzar Mecanum');
            move?.(0.15, 0, 0);
          }
          break;
        case 'arrowdown':
          e.preventDefault();
          setLastKeyPressed('Retroceder Mecanum');
          move?.(-0.15, 0, 0);
          break;
        case 'arrowleft':
          e.preventDefault();
          setLastKeyPressed('Strafe Izquierda');
          move?.(0, 0.15, 0);
          break;
        case 'arrowright':
          e.preventDefault();
          setLastKeyPressed('Strafe Derecha');
          move?.(0, -0.15, 0);
          break;
        case 'f':
          setLastKeyPressed('Gesto: Facepalm');
          trigger?.('facepalm');
          break;
        case 'g':
          setLastKeyPressed('Gesto: Trash Toss');
          trigger?.('trash_toss');
          break;
        case 'h':
          setLastKeyPressed('Gesto: Chef Kiss');
          trigger?.('chef_kiss');
          break;
        case 'v':
          setLastKeyPressed('Gesto: Victory Spin');
          trigger?.('victory_spin');
          break;
        case '0':
          setLastKeyPressed('Reset Home');
          setLocalLidarM(null);
          onResetScene?.();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    enableKeyboard,
    effectiveLidarM,
    jog,
    onGripperSet,
    move,
    trigger,
    onResetScene,
  ]);

  const webcamActiveRef = useRef(false);
  useEffect(() => {
    webcamActiveRef.current = webcamActive;
  }, [webcamActive]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 540;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#ECEAE3');

    // Full-body camera framing so the entire Mecanum chassis + 6-DOF arm + Gripper fits with headroom
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.02, 20);
    camera.position.set(0.72, 0.56, 0.66);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in three r18x
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0.04, 0.21, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.minDistance = 0.28;
    controls.maxDistance = 2.4;

    // Calibrated 4-Point Studio Lighting (zero white blowout, crisp detail on Mecanum wheels & arm)
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xd4d2c8, 1.1);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
    dirLight.position.set(1.2, 2.2, 1.1);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xf8fafc, 0.65);
    fillLight.position.set(-1.1, 0.9, -0.8);
    scene.add(fillLight);

    const frontLowLight = new THREE.DirectionalLight(0xffffff, 0.75);
    frontLowLight.position.set(0.9, 0.35, 1.1);
    scene.add(frontLowLight);

    // Grounded Calibration Floor & Technical Grid
    const floorGeo = new THREE.PlaneGeometry(3.2, 3.2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xe6e4dd,
      roughness: 0.9,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(1.8, 18, 0x94a3b8, 0xcbd5e1);
    grid.position.y = 0.001;
    scene.add(grid);

    // ROS Coordinate Root (+X forward, +Y left, +Z up)
    const rosWorld = new THREE.Group();
    rosWorld.rotation.x = -Math.PI / 2;
    scene.add(rosWorld);

    // Robot Odometry Root
    const baseFootprint = new THREE.Group();
    rosWorld.add(baseFootprint);

    // 360° LiDAR Safety Perimeter Ring (radius = 0.25m on floor around robot)
    const lidarRingMat = new THREE.MeshBasicMaterial({
      color: 0x0284c7,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.65,
    });
    const lidarRing = new THREE.Mesh(new THREE.RingGeometry(0.242, 0.252, 64), lidarRingMat);
    lidarRing.position.set(0, 0, 0.003);
    baseFootprint.add(lidarRing);

    // Rotating LiDAR Scan Sector Fan on floor
    const lidarBeamMat = new THREE.MeshBasicMaterial({
      color: 0x0284c7,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.16,
    });
    const lidarBeam = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 32, -0.35, 0.7),
      lidarBeamMat
    );
    lidarBeam.position.set(0, 0, 0.002);
    baseFootprint.add(lidarBeam);

    // Movable 3D Obstacle in front of robot to visualize LiDAR distance & safety stop
    const obstacleGroup = new THREE.Group();
    rosWorld.add(obstacleGroup);
    const obstacleMat = new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.35,
      metalness: 0.1,
    });
    const obstacleBox = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.16), obstacleMat);
    obstacleBox.position.set(0, 0, 0.08);
    obstacleBox.castShadow = true;
    obstacleGroup.add(obstacleBox);

    // Exact URDF Kinematic Hierarchy from Hiwonder/ROSOrin-Pro
    const baseJoint = createUrdfJoint(baseFootprint, [0, 0, 0.025], [0, 0, 0], [0, 0, 1]);
    const lidarJoint = createUrdfJoint(
      baseJoint.pivot,
      [0.048156, 0.0000755, 0.106748],
      [0, 0, Math.PI],
      [0, 0, 1]
    );

    const joint1 = createUrdfJoint(
      baseJoint.pivot,
      [0.04662, 0.0000754, 0.16044],
      [0.0087266, 0, 0],
      [-0.0000545, -0.0087266, -0.99996]
    );
    const joint2 = createUrdfJoint(
      joint1.pivot,
      [0.000012, 0.018766, 0.030345],
      [0, 0, 0],
      [0, 0.99996, -0.0087265]
    );
    const joint3 = createUrdfJoint(
      joint2.pivot,
      [0.00025563, 0.00074282, 0.08513],
      [0, 0, 0],
      [0, 1, 0]
    );
    const joint4 = createUrdfJoint(
      joint3.pivot,
      [-0.00056892, 0.00074297, 0.085147],
      [0, 0, 0],
      [0, 1, 0]
    );

    const camConnectJoint = createUrdfJoint(
      joint4.pivot,
      [-0.036369, -0.0181, 0.046638],
      [-1.5621, -1.5621, 1.5708],
      [0, 0, 1]
    );
    const camJoint = createUrdfJoint(
      camConnectJoint.pivot,
      [0.022511, -0.0010257, 0.0051917],
      [0, 0, 0],
      [0, 0, 1]
    );

    // 3D Camera Frustum Cone projecting from the Aurora 930 Pro camera ONLY when Webcam is active
    const camConeGeo = new THREE.ConeGeometry(0.055, 0.14, 4);
    camConeGeo.rotateX(Math.PI / 2);
    const camConeMat = new THREE.MeshBasicMaterial({
      color: 0xff5500,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
    });
    const camCone = new THREE.Mesh(camConeGeo, camConeMat);
    camCone.position.set(0.07, 0, 0);
    camCone.visible = false;
    camJoint.pivot.add(camCone);

    const joint5 = createUrdfJoint(
      joint4.pivot,
      [-0.0010116, -0.018014, 0.05577],
      [0, 0, 0],
      [0, 0, -1]
    );
    const gripperBaseJoint = createUrdfJoint(
      joint5.pivot,
      [0, 0, 0.0030019],
      [-3.1416, -1.5681, 3.1416],
      [0, 0, 1]
    );

    const rJoint = createUrdfJoint(
      gripperBaseJoint.pivot,
      [0.024, -0.014, 0.0061523],
      [-0.0038422, 1.5647, -0.012569],
      [0.99998, 0.0000152, -0.0060469]
    );
    const lJoint = createUrdfJoint(
      gripperBaseJoint.pivot,
      [0.024, 0.014, 0.0075],
      [3.1416, 1.5681, 3.1416],
      [-1, 0, -0.0026676]
    );
    const rInJoint = createUrdfJoint(
      gripperBaseJoint.pivot,
      [0.042974, -0.005, 0.0075],
      [3.1416, 1.5681, 3.1416],
      [1, 0, 0.0026676]
    );
    const rOutJoint = createUrdfJoint(
      rInJoint.pivot,
      [-0.0000593, -0.018641, 0.022215],
      [0, 0, 0.0069813],
      [0.99997, -0.0069812, 0.0026676]
    );
    const lInJoint = createUrdfJoint(
      gripperBaseJoint.pivot,
      [0.042974, 0.005, 0.0075],
      [3.1416, 1.5681, 3.1416],
      [1, 0, 0.0026676]
    );
    const lOutJoint = createUrdfJoint(
      lInJoint.pivot,
      [0.0029407, 0.018641, 0.022223],
      [0, 0, 0],
      [1, 0, 0.0026676]
    );

    // LED Status Ring on Chassis
    const ledRingMat = new THREE.MeshStandardMaterial({
      color: 0x059669,
      emissive: 0x059669,
      emissiveIntensity: 0.75,
    });
    const ledRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.036, 0.004, 12, 32),
      ledRingMat
    );
    ledRing.position.set(0.048, 0, 0.088);
    baseJoint.pivot.add(ledRing);

    // Physical Asset in Gripper for Demo B (Deploy Key Badge)
    const heldKeyGroup = new THREE.Group();
    heldKeyGroup.position.set(0, 0, 0.078);
    heldKeyGroup.visible = sceneMode === 'gatekeeper';
    joint5.pivot.add(heldKeyGroup);

    const keyMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      metalness: 0.2,
      roughness: 0.25,
    });
    const keyMesh = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.018, 0.056), keyMat);
    keyMesh.castShadow = true;
    heldKeyGroup.add(keyMesh);

    // Demo B Trays on the Table
    const gatekeeperGroup = new THREE.Group();
    gatekeeperGroup.visible = sceneMode === 'gatekeeper';
    rosWorld.add(gatekeeperGroup);

    const approveTray = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.11, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x059669, roughness: 0.4 })
    );
    approveTray.position.set(0.18, 0.19, 0.006);
    gatekeeperGroup.add(approveTray);

    const rejectTray = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.11, 0.012),
      new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.4 })
    );
    rejectTray.position.set(0.18, -0.19, 0.006);
    gatekeeperGroup.add(rejectTray);

    const droppedKeyMesh = keyMesh.clone();
    droppedKeyMesh.visible = false;
    gatekeeperGroup.add(droppedKeyMesh);

    // Demo C 3 Physical Service Totems on the Stage Table + 3D Backboard Labels
    const bughunterGroup = new THREE.Group();
    bughunterGroup.visible = sceneMode === 'bughunter';
    rosWorld.add(bughunterGroup);

    const labelTextures: THREE.Texture[] = [];
    const createTotemLabelSprite = (title: string, accentHex: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 144;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#111215';
        ctx.beginPath();
        ctx.roundRect(8, 8, 496, 128, 22);
        ctx.fill();

        ctx.lineWidth = 6;
        ctx.strokeStyle = accentHex;
        ctx.stroke();

        ctx.fillStyle = accentHex;
        ctx.beginPath();
        ctx.arc(54, 72, 14, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 42px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(title, 86, 74);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      labelTextures.push(tex);
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(0.13, 0.036, 1);
      return sprite;
    };

    const totemSpecs = [
      { id: 'cloud_run', label: 'CLOUD RUN', y: 0.22, color: 0x2563eb, hex: '#2563EB' },
      { id: 'gemini_live', label: 'GEMINI LIVE', y: 0.0, color: 0x0d9488, hex: '#0D9488' },
      { id: 'firestore', label: 'FIRESTORE', y: -0.22, color: 0xff5500, hex: '#FF5500' },
    ];
    const totemMeshes: Record<string, THREE.Mesh> = {};
    for (const spec of totemSpecs) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.028, 0.095, 0.145),
        new THREE.MeshStandardMaterial({
          color: spec.color,
          roughness: 0.3,
          metalness: 0.1,
        })
      );
      m.position.set(0.34, spec.y, 0.0725);
      m.castShadow = true;
      bughunterGroup.add(m);
      totemMeshes[spec.id] = m;

      const labelSprite = createTotemLabelSprite(spec.label, spec.hex);
      labelSprite.position.set(0.33, spec.y, 0.172);
      bughunterGroup.add(labelSprite);
    }

    // SOLID, OPAQUE, HIGH-CONTRAST INDUSTRIAL MATERIALS (Zero transparent/washed-out parts)
    const loader = new STLLoader();

    // 1. Mecanum Chassis & Rollers: Solid Titanium Slate (#526075)
    const chassisSteelMat = new THREE.MeshStandardMaterial({
      color: 0x526075,
      roughness: 0.42,
      metalness: 0.18,
      side: THREE.DoubleSide,
    });

    // 2. Arm Structural Links (Link 1, Link 3, Link 5): Anodized Cobalt Blue (#2563EB)
    const armCobaltMat = new THREE.MeshStandardMaterial({
      color: 0x2563eb,
      roughness: 0.36,
      metalness: 0.15,
      side: THREE.DoubleSide,
    });

    // 3. Hiwonder Servo Brackets (Link 2, Link 4, Outer Gripper Claws): Industrial Orange (#FF5500)
    const hiwonderOrangeMat = new THREE.MeshStandardMaterial({
      color: 0xff5500,
      roughness: 0.32,
      metalness: 0.12,
      side: THREE.DoubleSide,
    });

    // 4. Parallel Gripper Linkage: Precision Teal (#0D9488)
    const gripperTealMat = new THREE.MeshStandardMaterial({
      color: 0x0d9488,
      roughness: 0.34,
      metalness: 0.15,
      side: THREE.DoubleSide,
    });

    // 5. MS200 LiDAR Turret: Sensor Cyan (#0284C7)
    const lidarCyanMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      roughness: 0.3,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });

    // 6. Aurora 930 Pro 3D Camera Module: Deep Slate (#334155)
    const cameraSlateMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.38,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });

    const solidEdgeMat = new THREE.LineBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: 0.2,
    });

    const stlList: Array<{ url: string; target: THREE.Object3D; mat: THREE.Material }> = [
      { url: '/meshes/mecanum/base_link.stl', target: baseJoint.pivot, mat: chassisSteelMat },
      { url: '/meshes/common/lidar_link.stl', target: lidarJoint.pivot, mat: lidarCyanMat },
      { url: '/meshes/arm/link1.stl', target: joint1.pivot, mat: armCobaltMat },
      { url: '/meshes/arm/link2.stl', target: joint2.pivot, mat: hiwonderOrangeMat },
      { url: '/meshes/arm/link3.stl', target: joint3.pivot, mat: armCobaltMat },
      { url: '/meshes/arm/link4.stl', target: joint4.pivot, mat: hiwonderOrangeMat },
      { url: '/meshes/arm/camera_connect_link.stl', target: camConnectJoint.pivot, mat: cameraSlateMat },
      { url: '/meshes/arm/camera_link.stl', target: camJoint.pivot, mat: cameraSlateMat },
      { url: '/meshes/arm/link5.stl', target: joint5.pivot, mat: armCobaltMat },
      { url: '/meshes/arm/gripper_link.stl', target: gripperBaseJoint.pivot, mat: gripperTealMat },
      { url: '/meshes/gripper/r_link.stl', target: rJoint.pivot, mat: gripperTealMat },
      { url: '/meshes/gripper/l_link.stl', target: lJoint.pivot, mat: gripperTealMat },
      { url: '/meshes/gripper/r_in_link.stl', target: rInJoint.pivot, mat: armCobaltMat },
      { url: '/meshes/gripper/r_out_link.stl', target: rOutJoint.pivot, mat: hiwonderOrangeMat },
      { url: '/meshes/gripper/l_in_link.stl', target: lInJoint.pivot, mat: armCobaltMat },
      { url: '/meshes/gripper/l_out_link.stl', target: lOutJoint.pivot, mat: hiwonderOrangeMat },
    ];

    let loadedCount = 0;
    let disposed = false;
    setMeshErrors([]);
    for (const item of stlList) {
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
    }

    let animId = 0;
    let lastFrameTime = performance.now();
    const ledColor = new THREE.Color();
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0.001, (now - lastFrameTime) / 1000));
      lastFrameTime = now;
      const lerpAlpha = 1 - Math.exp(-12 * dt);

      const st = telemetryRef.current;

      camCone.visible = webcamActiveRef.current;

      if (st.rgb) {
        ledColor.setRGB(st.rgb[0] / 255, st.rgb[1] / 255, st.rgb[2] / 255);
        ledRingMat.color.copy(ledColor);
        ledRingMat.emissive.copy(ledColor);
      }

      const targetX = st.odometry?.x_m || 0;
      const targetY = st.odometry?.y_m || 0;
      const targetYaw = st.odometry?.yaw_rad || 0;
      baseFootprint.position.x += (targetX - baseFootprint.position.x) * lerpAlpha;
      baseFootprint.position.y += (targetY - baseFootprint.position.y) * lerpAlpha;
      baseFootprint.rotation.z += (targetYaw - baseFootprint.rotation.z) * lerpAlpha;

      lidarJoint.pivot.rotation.z += 4.8 * dt;
      lidarBeam.rotation.z += 4.8 * dt;

      const frontDist = st.lidar?.front_m ?? 1.42;
      const isAlert = frontDist < 0.28 || st.lidar?.obstacle_alert;
      lidarRingMat.color.setHex(isAlert ? 0xdc2626 : 0x0284c7);
      lidarBeamMat.color.setHex(isAlert ? 0xdc2626 : 0x0284c7);
      obstacleGroup.visible = frontDist < 0.85;
      obstacleGroup.position.set(baseFootprint.position.x + frontDist, baseFootprint.position.y, 0);

      const p1 = st.servos?.['1'] ?? 500;
      const p2 = st.servos?.['2'] ?? 430;
      const p3 = st.servos?.['3'] ?? 310;
      const p4 = st.servos?.['4'] ?? 380;
      const p5 = st.servos?.['5'] ?? 500;
      const p10 = st.servos?.['10'] ?? 500;

      const joints: Array<[JointNode, number]> = [
        [joint1, pulseToRadians(1, p1)],
        [joint2, pulseToRadians(2, p2)],
        [joint3, pulseToRadians(3, p3)],
        [joint4, pulseToRadians(4, p4)],
        [joint5, pulseToRadians(5, p5)],
      ];

      for (const [jn, targetRad] of joints) {
        jn.currentAngle += (targetRad - jn.currentAngle) * lerpAlpha;
        jn.pivot.setRotationFromAxisAngle(jn.axis, jn.currentAngle);
      }

      // Symmetric 4-bar parallel linkage for Servo 10:
      const gRad = pulseToRadians(10, p10);
      rJoint.currentAngle += (gRad - rJoint.currentAngle) * lerpAlpha;
      const openAngle = rJoint.currentAngle;
      rJoint.pivot.setRotationFromAxisAngle(rJoint.axis, openAngle);
      rInJoint.pivot.setRotationFromAxisAngle(rInJoint.axis, openAngle);
      rOutJoint.pivot.setRotationFromAxisAngle(rOutJoint.axis, -openAngle);

      lJoint.pivot.setRotationFromAxisAngle(lJoint.axis, openAngle);
      lInJoint.pivot.setRotationFromAxisAngle(lInJoint.axis, -openAngle);
      lOutJoint.pivot.setRotationFromAxisAngle(lOutJoint.axis, openAngle);

      const heldState = st.held_object || 'deploy_key';
      if (sceneMode === 'gatekeeper') {
        gatekeeperGroup.visible = true;
        bughunterGroup.visible = false;
        if (heldState === 'released_approved') {
          heldKeyGroup.visible = false;
          droppedKeyMesh.visible = true;
          droppedKeyMesh.position.set(0.18, 0.19, 0.032);
        } else if (heldState === 'released_rejected') {
          heldKeyGroup.visible = false;
          droppedKeyMesh.visible = true;
          droppedKeyMesh.position.set(0.18, -0.19, 0.032);
        } else {
          heldKeyGroup.visible = true;
          droppedKeyMesh.visible = false;
        }
      } else if (sceneMode === 'bughunter') {
        gatekeeperGroup.visible = false;
        bughunterGroup.visible = true;
        heldKeyGroup.visible = false;
        const pointed = st.pointed_totem;
        for (const [id, mesh] of Object.entries(totemMeshes)) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (pointed === id) {
            mat.emissive.copy(mat.color);
            mat.emissiveIntensity = 0.55;
            mesh.scale.set(1.12, 1.12, 1.08);
          } else {
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 0;
            mesh.scale.set(1, 1, 1);
          }
        }
      } else {
        gatekeeperGroup.visible = false;
        bughunterGroup.visible = false;
        heldKeyGroup.visible = false;
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      if (w > 0 && h > 0) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
    });
    resizeObserver.observe(container);

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
  }, [sceneMode]);

  const gripperPulse = telemetry.servos?.['10'] ?? 500;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[#F1F3F4]">
      {/* 1. CLEAN GOOGLE TOP TOOLBAR */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#DADCE0] bg-white px-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#1A73E8]" />
            <span className="text-sm font-bold text-[#202124]">
              Simulador 3D{' '}
              <span className="font-normal text-[#5F6368]">({meshesLoaded}/16 piezas)</span>
            </span>
            {meshErrors.length > 0 && (
              <span role="alert" className="text-xs font-bold text-[#D93025]">
                No cargó: {meshErrors.join(', ')}
              </span>
            )}
          </div>
          <div className="h-4 w-px bg-[#DADCE0]" />
          <span className="text-xs font-medium text-[#5F6368]">
            Pinza: <strong className="text-[#1A73E8]">{gripperPulse}</strong>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleToggleObstacle}
            aria-pressed={lidarBlocked}
            className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
              lidarBlocked
                ? 'border-[#D93025] bg-[#D93025] text-white'
                : 'border-[#DADCE0] bg-[#F8F9FA] text-[#202124] hover:border-[#1A73E8]'
            }`}
          >
            {lidarBlocked
              ? `LiDAR: ${effectiveLidarM.toFixed(2)} m (Freno)`
              : `LiDAR: ${effectiveLidarM.toFixed(2)} m`}
          </button>

          <button
            type="button"
            onClick={() => setWebcamActive((v) => !v)}
            aria-pressed={webcamActive}
            className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
              webcamActive
                ? 'border-[#1A73E8] bg-[#1A73E8] text-white'
                : 'border-[#DADCE0] bg-[#F8F9FA] text-[#202124] hover:border-[#1A73E8]'
            }`}
          >
            {webcamActive ? 'Webcam: Activa' : 'Webcam'}
          </button>

          {onResetScene && (
            <button
              type="button"
              onClick={onResetScene}
              className="rounded-lg border border-[#DADCE0] bg-[#F8F9FA] px-3 py-1.5 text-xs font-bold text-[#5F6368] hover:border-[#1A73E8] hover:text-[#1A73E8]"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* 2. FULL-BLEED 3D WEBGL STAGE */}
      <div ref={mountRef} className="relative flex-1 w-full overflow-hidden bg-[#F1F3F4]" />

      {/* Picture-in-Picture Live Webcam Feed (Aurora 930 Pro) */}
      {webcamActive && (
        <div className="absolute top-14 right-4 z-10 w-44 overflow-hidden rounded-xl border-2 border-[#1A73E8] bg-[#202124] shadow-lg">
          <video ref={videoRef} muted playsInline className="h-32 w-full object-cover" />
          <div className="bg-[#202124] px-2.5 py-1 text-xs font-semibold text-white">
            Cámara 3D · 1 FPS
          </div>
        </div>
      )}

      {/* 3. STRUCTURAL BOTTOM STATUS BAR */}
      {enableKeyboard && (
        <div className="flex h-10 shrink-0 items-center justify-between border-t border-[#DADCE0] bg-white px-4 text-xs font-medium text-[#5F6368]">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="rounded border border-[#DADCE0] bg-[#F8F9FA] px-1.5 py-0.5 font-mono text-xs font-semibold text-[#202124]">
                1/Q..5/T
              </kbd>{' '}
              Brazo
            </span>
            <span>
              <kbd className="rounded border border-[#DADCE0] bg-[#F8F9FA] px-1.5 py-0.5 font-mono text-xs font-semibold text-[#202124]">
                O / C
              </kbd>{' '}
              Pinza
            </span>
            <span>
              <kbd className="rounded border border-[#DADCE0] bg-[#F8F9FA] px-1.5 py-0.5 font-mono text-xs font-semibold text-[#202124]">
                ↑↓←→
              </kbd>{' '}
              Ruedas
            </span>
          </div>

          <div className="flex items-center gap-3">
            {lastKeyPressed && (
              <span className="rounded-md bg-[#1A73E8] px-2.5 py-0.5 text-xs font-bold text-white">
                {lastKeyPressed}
              </span>
            )}
            <span className="text-xs text-[#5F6368]">
              X: {(telemetry.odometry?.x_m ?? 0).toFixed(2)} m · Y:{' '}
              {(telemetry.odometry?.y_m ?? 0).toFixed(2)} m
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
