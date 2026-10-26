'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FALLBACK_TELEMETRY, RobotBridgeClient } from './robot-client';
import type { TelemetryState } from './types';

function clampServoForHardware(id: number, pulse: number): number {
  const p = Math.round(pulse);
  switch (id) {
    case 1:
      return Math.max(120, Math.min(880, p));
    case 2:
      return Math.max(220, Math.min(780, p));
    case 3:
    case 4:
      return Math.max(150, Math.min(850, p));
    case 5:
      return Math.max(100, Math.min(900, p));
    case 10:
      return Math.max(200, Math.min(750, p));
    default:
      return Math.max(150, Math.min(850, p));
  }
}

const LOCAL_GESTURE_TARGETS: Record<
  string,
  {
    servos: Record<string, number>;
    odometry?: { x_m: number; y_m: number; yaw_rad: number };
    rgb: [number, number, number];
    held_object?: string;
    pointed_totem?: string | null;
  }
> = {
  home: {
    servos: { '1': 500, '2': 430, '3': 310, '4': 380, '5': 500, '10': 500 },
    odometry: { x_m: 0, y_m: 0, yaw_rad: 0 },
    rgb: [43, 74, 203],
    pointed_totem: null,
  },
  facepalm: {
    servos: { '1': 360, '2': 520, '3': 200, '4': 220, '5': 380, '10': 680 },
    odometry: { x_m: -0.09, y_m: 0, yaw_rad: 0 },
    rgb: [220, 38, 38],
  },
  trash_toss: {
    servos: { '1': 210, '2': 400, '3': 300, '4': 320, '5': 300, '10': 220 },
    odometry: { x_m: -0.04, y_m: -0.10, yaw_rad: 0 },
    rgb: [234, 88, 12],
    held_object: 'released_rejected',
  },
  chef_kiss: {
    servos: { '1': 560, '2': 370, '3': 290, '4': 360, '5': 700, '10': 220 },
    odometry: { x_m: 0.06, y_m: 0, yaw_rad: 0 },
    rgb: [16, 185, 129],
  },
  suspicious_inspect: {
    servos: { '1': 380, '2': 340, '3': 280, '4': 340, '5': 380, '10': 240 },
    odometry: { x_m: 0.09, y_m: 0, yaw_rad: 0 },
    rgb: [245, 158, 11],
  },
  victory_spin: {
    servos: { '1': 660, '2': 470, '3': 360, '4': 420, '5': 260, '10': 220 },
    odometry: { x_m: 0, y_m: 0, yaw_rad: 0.75 },
    rgb: [59, 130, 246],
  },
  nod_yes: {
    servos: { '1': 500, '2': 360, '3': 260, '4': 290, '5': 500, '10': 260 },
    odometry: { x_m: 0.05, y_m: 0, yaw_rad: 0 },
    rgb: [34, 197, 94],
  },
  shake_no: {
    servos: { '1': 300, '2': 420, '3': 300, '4': 370, '5': 350, '10': 660 },
    odometry: { x_m: -0.06, y_m: 0, yaw_rad: 0 },
    rgb: [220, 38, 38],
  },
  gatekeeper_hold: {
    servos: { '1': 500, '2': 430, '3': 310, '4': 380, '5': 500, '10': 680 },
    odometry: { x_m: 0, y_m: 0, yaw_rad: 0 },
    rgb: [245, 158, 11],
    held_object: 'deploy_key',
    pointed_totem: null,
  },
  gatekeeper_approve: {
    servos: { '1': 700, '2': 350, '3': 260, '4': 330, '5': 500, '10': 220 },
    odometry: { x_m: 0.04, y_m: 0.06, yaw_rad: 0 },
    rgb: [16, 185, 129],
    held_object: 'released_approved',
  },
  gatekeeper_reject: {
    servos: { '1': 280, '2': 350, '3': 260, '4': 330, '5': 500, '10': 220 },
    odometry: { x_m: -0.08, y_m: -0.06, yaw_rad: 0 },
    rgb: [220, 38, 38],
    held_object: 'released_rejected',
  },
  point_cloud_run: {
    servos: { '1': 610, '2': 350, '3': 270, '4': 350, '5': 500, '10': 660 },
    odometry: { x_m: 0.04, y_m: 0.20, yaw_rad: 0 },
    rgb: [43, 74, 203],
    pointed_totem: 'cloud_run',
  },
  point_gemini_live: {
    servos: { '1': 500, '2': 340, '3': 260, '4': 340, '5': 500, '10': 660 },
    odometry: { x_m: 0.06, y_m: 0, yaw_rad: 0 },
    rgb: [15, 118, 110],
    pointed_totem: 'gemini_live',
  },
  point_firestore: {
    servos: { '1': 390, '2': 350, '3': 270, '4': 350, '5': 500, '10': 660 },
    odometry: { x_m: 0.04, y_m: -0.20, yaw_rad: 0 },
    rgb: [180, 83, 9],
    pointed_totem: 'firestore',
  },
  wave_hello: {
    servos: { '1': 560, '2': 580, '3': 380, '4': 460, '5': 680, '10': 260 },
    odometry: { x_m: 0.03, y_m: 0, yaw_rad: 0.12 },
    rgb: [59, 130, 246],
  },
  bumblebee_hype: {
    servos: { '1': 640, '2': 610, '3': 420, '4': 460, '5': 720, '10': 240 },
    odometry: { x_m: 0.06, y_m: 0.08, yaw_rad: 0.45 },
    rgb: [251, 188, 4],
  },
  bumblebee_groove: {
    servos: { '1': 380, '2': 490, '3': 350, '4': 410, '5': 320, '10': 340 },
    odometry: { x_m: 0.02, y_m: -0.12, yaw_rad: -0.25 },
    rgb: [26, 115, 232],
  },
  bumblebee_rock_out: {
    servos: { '1': 520, '2': 310, '3': 220, '4': 260, '5': 680, '10': 220 },
    odometry: { x_m: 0.09, y_m: 0, yaw_rad: 0.18 },
    rgb: [234, 67, 53],
  },
  bumblebee_romance: {
    servos: { '1': 580, '2': 460, '3': 360, '4': 430, '5': 600, '10': 580 },
    odometry: { x_m: 0.04, y_m: 0.06, yaw_rad: 0.15 },
    rgb: [233, 30, 99],
  },
  bumblebee_sad_droop: {
    servos: { '1': 450, '2': 560, '3': 210, '4': 210, '5': 500, '10': 640 },
    odometry: { x_m: -0.07, y_m: 0, yaw_rad: -0.12 },
    rgb: [95, 99, 104],
  },
  bumblebee_sassy: {
    servos: { '1': 330, '2': 530, '3': 390, '4': 470, '5': 260, '10': 250 },
    odometry: { x_m: 0.03, y_m: -0.09, yaw_rad: -0.52 },
    rgb: [52, 168, 83],
  },
};

const LOCAL_CHOREOGRAPHIES: Record<
  string,
  Array<{
    delayMs: number;
    servos: Record<string, number>;
    odometry?: { x_m: number; y_m: number; yaw_rad: number };
    rgb: [number, number, number];
  }>
> = {
  bumblebee_hype: [
    {
      delayMs: 0,
      servos: { '1': 660, '2': 610, '3': 420, '4': 480, '5': 740, '10': 230 },
      odometry: { x_m: 0.06, y_m: 0.09, yaw_rad: 0.45 },
      rgb: [251, 188, 4],
    },
    {
      delayMs: 420,
      servos: { '1': 340, '2': 520, '3': 350, '4': 360, '5': 260, '10': 650 },
      odometry: { x_m: 0.02, y_m: -0.09, yaw_rad: -0.45 },
      rgb: [234, 67, 53],
    },
    {
      delayMs: 840,
      servos: { '1': 620, '2': 590, '3': 410, '4': 460, '5': 700, '10': 240 },
      odometry: { x_m: 0.07, y_m: 0.05, yaw_rad: 0.32 },
      rgb: [52, 168, 83],
    },
    {
      delayMs: 1260,
      servos: { '1': 500, '2': 450, '3': 330, '4': 400, '5': 500, '10': 380 },
      odometry: { x_m: 0.03, y_m: 0, yaw_rad: 0.08 },
      rgb: [251, 188, 4],
    },
  ],
  bumblebee_groove: [
    {
      delayMs: 0,
      servos: { '1': 370, '2': 490, '3': 350, '4': 420, '5': 300, '10': 260 },
      odometry: { x_m: 0.02, y_m: -0.12, yaw_rad: -0.28 },
      rgb: [26, 115, 232],
    },
    {
      delayMs: 450,
      servos: { '1': 630, '2': 440, '3': 310, '4': 370, '5': 700, '10': 620 },
      odometry: { x_m: 0.02, y_m: 0.12, yaw_rad: 0.28 },
      rgb: [251, 188, 4],
    },
    {
      delayMs: 900,
      servos: { '1': 410, '2': 510, '3': 370, '4': 430, '5': 350, '10': 280 },
      odometry: { x_m: 0.04, y_m: -0.06, yaw_rad: -0.15 },
      rgb: [26, 115, 232],
    },
  ],
  bumblebee_rock_out: [
    {
      delayMs: 0,
      servos: { '1': 520, '2': 290, '3': 200, '4': 240, '5': 720, '10': 220 },
      odometry: { x_m: 0.09, y_m: 0, yaw_rad: 0.22 },
      rgb: [234, 67, 53],
    },
    {
      delayMs: 380,
      servos: { '1': 480, '2': 560, '3': 410, '4': 480, '5': 280, '10': 680 },
      odometry: { x_m: -0.05, y_m: 0, yaw_rad: -0.22 },
      rgb: [251, 188, 4],
    },
    {
      delayMs: 760,
      servos: { '1': 540, '2': 310, '3': 220, '4': 260, '5': 680, '10': 220 },
      odometry: { x_m: 0.08, y_m: 0.04, yaw_rad: 0.18 },
      rgb: [234, 67, 53],
    },
  ],
  bumblebee_romance: [
    {
      delayMs: 0,
      servos: { '1': 590, '2': 470, '3': 370, '4': 440, '5': 640, '10': 580 },
      odometry: { x_m: 0.04, y_m: 0.07, yaw_rad: 0.2 },
      rgb: [233, 30, 99],
    },
    {
      delayMs: 520,
      servos: { '1': 410, '2': 450, '3': 350, '4': 410, '5': 360, '10': 280 },
      odometry: { x_m: 0.04, y_m: -0.07, yaw_rad: -0.2 },
      rgb: [251, 188, 4],
    },
    {
      delayMs: 1040,
      servos: { '1': 550, '2': 460, '3': 360, '4': 430, '5': 580, '10': 540 },
      odometry: { x_m: 0.03, y_m: 0.03, yaw_rad: 0.1 },
      rgb: [233, 30, 99],
    },
  ],
  bumblebee_sad_droop: [
    {
      delayMs: 0,
      servos: { '1': 440, '2': 570, '3': 200, '4': 200, '5': 420, '10': 650 },
      odometry: { x_m: -0.08, y_m: -0.04, yaw_rad: -0.18 },
      rgb: [95, 99, 104],
    },
    {
      delayMs: 520,
      servos: { '1': 560, '2': 550, '3': 220, '4': 220, '5': 580, '10': 600 },
      odometry: { x_m: -0.06, y_m: 0.04, yaw_rad: 0.16 },
      rgb: [59, 130, 246],
    },
  ],
  bumblebee_sassy: [
    {
      delayMs: 0,
      servos: { '1': 320, '2': 540, '3': 400, '4': 480, '5': 240, '10': 230 },
      odometry: { x_m: 0.04, y_m: -0.11, yaw_rad: -0.55 },
      rgb: [52, 168, 83],
    },
    {
      delayMs: 420,
      servos: { '1': 680, '2': 500, '3': 360, '4': 430, '5': 760, '10': 660 },
      odometry: { x_m: 0.04, y_m: 0.11, yaw_rad: 0.55 },
      rgb: [251, 188, 4],
    },
    {
      delayMs: 840,
      servos: { '1': 360, '2': 530, '3': 390, '4': 470, '5': 280, '10': 250 },
      odometry: { x_m: 0.03, y_m: -0.06, yaw_rad: -0.35 },
      rgb: [52, 168, 83],
    },
  ],
};

export function useRobotTelemetry() {
  const [telemetry, setTelemetry] = useState<TelemetryState>(FALLBACK_TELEMETRY);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const bridgeRef = useRef<RobotBridgeClient | null>(null);
  const connectedRef = useRef(false);
  const lastFrameAtRef = useRef(0);
  const choreoTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  if (!bridgeRef.current) {
    bridgeRef.current = new RobotBridgeClient();
  }

  useEffect(() => {
    const client = new RobotBridgeClient(
      undefined,
      (t) => {
        lastFrameAtRef.current = Date.now();
        setTelemetry(t);
        setBridgeConnected(true);
        connectedRef.current = true;
      },
      (isConnected) => {
        if (!isConnected) {
          setBridgeConnected(false);
          connectedRef.current = false;
        }
      }
    );
    bridgeRef.current = client;
    client.connectWebSocket();

    const watchdog = setInterval(() => {
      if (connectedRef.current && Date.now() - lastFrameAtRef.current > 1500) {
        connectedRef.current = false;
        setBridgeConnected(false);
      }
    }, 500);

    return () => {
      clearInterval(watchdog);
      client.disconnect();
    };
  }, []);

  const jogServo = useCallback(async (id: number, delta: number) => {
    setTelemetry((prev) => {
      const cur = prev.servos[String(id)] ?? 500;
      const next = clampServoForHardware(id, cur + delta);
      return {
        ...prev,
        servos: { ...prev.servos, [String(id)]: next },
        active_gesture: `jog_id_${id}`,
      };
    });
    if (bridgeRef.current) {
      try {
        await bridgeRef.current.jogServo(id, delta);
      } catch {
        // local fallback already applied
      }
    }
  }, []);

  const setServoPulse = useCallback(async (id: number, pulse: number, duration_ms = 250) => {
    const clamped = clampServoForHardware(id, pulse);
    setTelemetry((prev) => ({
      ...prev,
      servos: { ...prev.servos, [String(id)]: clamped },
      active_gesture: `set_id_${id}`,
    }));
    if (bridgeRef.current) {
      try {
        await bridgeRef.current.setArm([{ id, position: clamped }], duration_ms);
      } catch {
        // local fallback already applied
      }
    }
  }, []);

  const moveChassis = useCallback(
    async (vx: number, vy: number, wz: number, durationMs = 420) => {
      if (bridgeRef.current && connectedRef.current) {
        try {
          await bridgeRef.current.moveChassis(vx, vy, wz, durationMs);
          return;
        } catch {
          // fall through to local offline integration
        }
      }
      const dt = durationMs / 1000;
      setTelemetry((prev) => {
        const blockedForward = prev.lidar.front_m < 0.28 && vx > 0;
        const safeVx = blockedForward ? 0 : vx;
        const yaw_rad = prev.odometry.yaw_rad + wz * dt;
        const x_m =
          prev.odometry.x_m + (safeVx * Math.cos(yaw_rad) - vy * Math.sin(yaw_rad)) * dt;
        const y_m =
          prev.odometry.y_m + (safeVx * Math.sin(yaw_rad) + vy * Math.cos(yaw_rad)) * dt;
        return {
          ...prev,
          active_gesture: blockedForward ? 'lidar_safety_stop' : prev.active_gesture,
          odometry: { x_m, y_m, yaw_rad, vx: safeVx, vy, wz },
        };
      });
    },
    []
  );

  const simulateLidar = useCallback(async (front_m: number) => {
    const clamped = Math.max(0.08, Math.min(2.5, front_m));
    const alert = clamped < 0.28;
    setTelemetry((prev) => ({
      ...prev,
      lidar: {
        ...prev.lidar,
        front_m: clamped,
        obstacle_alert: alert,
      },
      rgb: alert ? [220, 38, 38] : [43, 74, 203],
      active_gesture: alert ? 'lidar_safety_stop' : prev.active_gesture,
    }));
    if (bridgeRef.current) {
      try {
        await bridgeRef.current.simulateLidarDistance(clamped);
      } catch {
        // local fallback already applied
      }
    }
  }, []);

  const triggerGesture = useCallback(async (gesture: string, mood = 'stage') => {
    for (const t of choreoTimersRef.current) {
      clearTimeout(t);
    }
    choreoTimersRef.current = [];

    const choreo = LOCAL_CHOREOGRAPHIES[gesture];
    if (choreo && choreo.length > 0) {
      for (const step of choreo) {
        const timer = setTimeout(() => {
          setTelemetry((prev) => ({
            ...prev,
            servos: { ...prev.servos, ...step.servos },
            odometry: step.odometry
              ? { ...prev.odometry, ...step.odometry }
              : prev.odometry,
            rgb: step.rgb,
            active_gesture: gesture,
            mood,
          }));
        }, step.delayMs);
        choreoTimersRef.current.push(timer);
      }
    } else {
      const preset = LOCAL_GESTURE_TARGETS[gesture];
      if (preset) {
        // Add a brief pre-swing if already in the same gesture so repeated calls visibly move
        setTelemetry((prev) => ({
          ...prev,
          servos: { ...prev.servos, ...preset.servos },
          odometry: preset.odometry
            ? { ...prev.odometry, ...preset.odometry }
            : prev.odometry,
          rgb: preset.rgb,
          active_gesture: gesture,
          mood,
          held_object: preset.held_object ?? prev.held_object,
          pointed_totem:
            preset.pointed_totem !== undefined ? preset.pointed_totem : prev.pointed_totem,
        }));
      }
    }
    if (bridgeRef.current) {
      try {
        await bridgeRef.current.triggerGesture(gesture, mood);
      } catch {
        // local fallback already applied
      }
    }
  }, []);

  const resetScene = useCallback(async () => {
    setTelemetry(FALLBACK_TELEMETRY);
    if (bridgeRef.current) {
      try {
        await bridgeRef.current.resetScene();
      } catch {
        // local fallback already applied
      }
    }
  }, []);

  return {
    telemetry,
    bridgeConnected,
    bridgeRef,
    client: bridgeRef.current,
    jogServo,
    setServoPulse,
    moveChassis,
    simulateLidar,
    triggerGesture,
    resetScene,
  };
}
