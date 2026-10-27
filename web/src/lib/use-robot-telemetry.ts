'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BRIDGE_AUTH_ERROR_EVENT,
  FALLBACK_TELEMETRY,
  RobotBridgeClient,
  describeBridgeError,
  executedMessage,
} from './robot-client';
import { isBridgeEnabled, onBridgeConfigChange, resolveBridgeUrl } from './bridge-config';
import type { BridgeUiState, RobotActionResult, ScanScene, TelemetryState } from './types';
import { GESTURES, GESTURE_ALIASES } from './gesture-choreographies.generated';
import {
  AIM_OBJECTS,
  DEFAULT_SIM_SCENE,
  aggregate,
  aimFor,
  aimSteps,
  refreshScan,
  runningScan,
  simCapture,
  sweepTimeline,
  type CaptureDetection,
} from './scene-scan-sim';
import { describeAim } from './scene-scan';

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

/**
 * Scene side effects the bridge applies when a gesture starts (backend.rs `run_gesture`).
 * The servo/chassis choreography itself comes from the generated GESTURES table.
 */
const LOCAL_GESTURE_SCENE: Record<string, { held_object?: string; pointed_totem?: string | null }> = {
  home: { held_object: 'deploy_key', pointed_totem: null },
  gatekeeper_hold: { held_object: 'deploy_key', pointed_totem: null },
  gatekeeper_approve: { held_object: 'released_approved' },
  gatekeeper_reject: { held_object: 'released_rejected' },
  trash_toss: { held_object: 'released_rejected' },
  point_cloud_run: { pointed_totem: 'cloud_run' },
  point_gemini_live: { pointed_totem: 'gemini_live' },
  point_firestore: { pointed_totem: 'firestore' },
};

const SERVO_IDS = ['1', '2', '3', '4', '5', '10'] as const;

/** Dead-reckons the chassis pose after holding (vx, vy, wz) for `dtS` seconds, like the bridge tick. */
function integrateOdometry(
  odom: TelemetryState['odometry'],
  [vx, vy, wz]: [number, number, number],
  dtS: number
): TelemetryState['odometry'] {
  const yaw_rad = odom.yaw_rad + wz * dtS;
  return {
    ...odom,
    x_m: odom.x_m + (vx * Math.cos(yaw_rad) - vy * Math.sin(yaw_rad)) * dtS,
    y_m: odom.y_m + (vx * Math.sin(yaw_rad) + vy * Math.cos(yaw_rad)) * dtS,
    yaw_rad,
    vx,
    vy,
    wz,
  };
}


const SIMULATOR_ONLY: RobotActionResult = {
  ok: true,
  target: 'simulator',
  message: 'Sin robot físico conectado: la acción se mostró solo en el simulador 3D.',
};

function initialBridgeState(): BridgeUiState {
  return {
    enabled: false,
    connected: false,
    authError: false,
    estopLatched: false,
    lidarStale: false,
    workerDown: false,
    url: '',
  };
}

export function useRobotTelemetry() {
  const [telemetry, setTelemetry] = useState<TelemetryState>(FALLBACK_TELEMETRY);
  const [bridge, setBridge] = useState<BridgeUiState>(initialBridgeState);
  const bridgeRef = useRef<RobotBridgeClient | null>(null);
  const connectedRef = useRef(false);
  const authErrorRef = useRef(false);
  const lastFrameAtRef = useRef(0);
  const choreoTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  // «Reconocer» simulated in the twin (no bridge): pending sweep timers and the latest local state.
  const scanTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const telemetryRef = useRef<TelemetryState>(FALLBACK_TELEMETRY);

  useEffect(() => {
    telemetryRef.current = telemetry;
  }, [telemetry]);

  if (!bridgeRef.current) {
    bridgeRef.current = new RobotBridgeClient();
  }

  useEffect(() => {
    let client: RobotBridgeClient | null = null;

    const setLink = (connected: boolean, authError: boolean) => {
      connectedRef.current = connected;
      authErrorRef.current = authError;
      setBridge((prev) =>
        prev.connected === connected && prev.authError === authError
          ? prev
          : {
              ...prev,
              connected,
              authError,
              ...(connected
                ? {}
                : { estopLatched: false, lidarStale: false, workerDown: false, lidarSource: undefined }),
            }
      );
    };

    const start = () => {
      client?.disconnect();
      const enabled = isBridgeEnabled();
      setBridge((prev) => ({ ...prev, enabled, url: resolveBridgeUrl() }));
      setLink(false, false);
      client = new RobotBridgeClient(
        undefined,
        (t) => {
          lastFrameAtRef.current = Date.now();
          setTelemetry(t);
          const estopLatched = Boolean(t.estop_latched);
          const lidarStale = Boolean(t.lidar_stale);
          const workerDown = t.connected === false;
          setBridge((prev) =>
            prev.estopLatched === estopLatched &&
            prev.lidarStale === lidarStale &&
            prev.workerDown === workerDown &&
            prev.lidarSource === t.lidar_source
              ? prev
              : { ...prev, estopLatched, lidarStale, workerDown, lidarSource: t.lidar_source }
          );
        },
        (link) => setLink(link.connected, link.authError)
      );
      bridgeRef.current = client;
      client.connectWebSocket();
    };

    start();
    const unsubscribe = onBridgeConfigChange(start);
    const onAuthError = () => {
      // Stop the WebSocket loop until the token changes (onBridgeConfigChange restarts it).
      client?.disconnect();
      setLink(false, true);
    };
    window.addEventListener(BRIDGE_AUTH_ERROR_EVENT, onAuthError);

    const watchdog = setInterval(() => {
      if (connectedRef.current && Date.now() - lastFrameAtRef.current > 1500) {
        setLink(false, authErrorRef.current);
      }
    }, 500);

    const choreoTimers = choreoTimersRef;
    const scanTimers = scanTimersRef;
    return () => {
      clearInterval(watchdog);
      // Pending steps of a local choreography must not update state after unmount.
      for (const t of choreoTimers.current) clearTimeout(t);
      choreoTimers.current = [];
      for (const t of scanTimers.current) clearTimeout(t);
      scanTimers.current = [];
      unsubscribe();
      window.removeEventListener(BRIDGE_AUTH_ERROR_EVENT, onAuthError);
      client?.disconnect();
    };
  }, []);

  /**
   * Sends an action to the bridge when the robot is connected. With no robot the
   * 3D twin already moved, so the result is "simulator". Errors are never swallowed:
   * they are logged and returned (401, 423 E-stop, timeouts…).
   */
  const sendToBridge = useCallback(
    async (label: string, fn: (c: RobotBridgeClient) => Promise<unknown>): Promise<RobotActionResult> => {
      const client = bridgeRef.current;
      if (authErrorRef.current) {
        return {
          ok: false,
          target: 'robot',
          code: 'unauthorized',
          message: 'El bridge pide token: la acción no llegó al robot.',
        };
      }
      if (!client || !connectedRef.current) return SIMULATOR_ONLY;
      try {
        return { ok: true, target: 'robot', message: executedMessage(await fn(client)) };
      } catch (err) {
        const { code, message } = describeBridgeError(err);
        console.warn(`[robot] ${label} falló (${code}): ${message}`);
        if (code === 'estop_latched') {
          setBridge((prev) => (prev.estopLatched ? prev : { ...prev, estopLatched: true }));
        }
        return { ok: false, target: 'robot', code, message };
      }
    },
    []
  );

  /**
   * Aborts a «Reconocer» simulated in the twin, like the bridge does: STOP (`estop`) or any other
   * motion command (`interrupted`) freezes the arm where it is and discards the views.
   */
  const abortLocalScan = useCallback((reason: 'estop' | 'interrupted') => {
    if (scanTimersRef.current.length === 0) return;
    for (const t of scanTimersRef.current) clearTimeout(t);
    scanTimersRef.current = [];
    setTelemetry((prev) =>
      prev.scan_env?.state === 'running'
        ? {
            ...prev,
            active_gesture: prev.active_gesture === 'scan_env' ? 'home' : prev.active_gesture,
            scan_env: {
              ...prev.scan_env,
              state: 'aborted',
              reason,
              detections: [],
              finished_at_ms: Date.now(),
              fresh: false,
              stale_reason: 'aborted',
            },
          }
        : prev
    );
  }, []);

  const jogServo = useCallback(
    async (id: number, delta: number) => {
      abortLocalScan('interrupted');
      setTelemetry((prev) => {
        const cur = prev.servos[String(id)] ?? 500;
        const next = clampServoForHardware(id, cur + delta);
        return {
          ...prev,
          servos: { ...prev.servos, [String(id)]: next },
          active_gesture: `jog_id_${id}`,
        };
      });
      return sendToBridge(`jog servo ${id}`, (c) => c.jogServo(id, delta));
    },
    [sendToBridge, abortLocalScan]
  );

  const setServoPulse = useCallback(
    async (id: number, pulse: number, duration_ms = 250) => {
      const clamped = clampServoForHardware(id, pulse);
      abortLocalScan('interrupted');
      setTelemetry((prev) => ({
        ...prev,
        servos: { ...prev.servos, [String(id)]: clamped },
        active_gesture: `set_id_${id}`,
      }));
      return sendToBridge(`servo ${id}`, (c) => c.setArm([{ id, position: clamped }], duration_ms));
    },
    [sendToBridge, abortLocalScan]
  );

  const moveChassis = useCallback(
    async (vx: number, vy: number, wz: number, durationMs = 420): Promise<RobotActionResult> => {
      if (connectedRef.current || authErrorRef.current) {
        return sendToBridge('cmd_vel', (c) => c.moveChassis(vx, vy, wz, durationMs));
      }
      const dt = durationMs / 1000;
      abortLocalScan('interrupted');
      setTelemetry((prev) => {
        const blockedForward = prev.lidar.front_m < 0.28 && vx > 0;
        const safeVx = blockedForward ? 0 : vx;
        const yaw_rad = prev.odometry.yaw_rad + wz * dt;
        const x_m =
          prev.odometry.x_m + (safeVx * Math.cos(yaw_rad) - vy * Math.sin(yaw_rad)) * dt;
        const y_m =
          prev.odometry.y_m + (safeVx * Math.sin(yaw_rad) + vy * Math.cos(yaw_rad)) * dt;
        const odometry = { x_m, y_m, yaw_rad, vx: safeVx, vy, wz };
        return {
          ...prev,
          active_gesture: blockedForward ? 'lidar_safety_stop' : prev.active_gesture,
          odometry,
          // Moving the chassis away from where «Reconocer» measured makes the scan stale (sticky)
          ...(prev.scan_env ? { scan_env: refreshScan(prev.scan_env, odometry, Date.now()) } : {}),
        };
      });
      return SIMULATOR_ONLY;
    },
    [sendToBridge, abortLocalScan]
  );

  const simulateLidar = useCallback(
    async (front_m: number) => {
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
      return sendToBridge('simulate/lidar', (c) => c.simulateLidarDistance(clamped));
    },
    [sendToBridge]
  );

  const triggerGesture = useCallback(
    async (gesture: string, mood = 'stage'): Promise<RobotActionResult> => {
      for (const t of choreoTimersRef.current) {
        clearTimeout(t);
      }
      choreoTimersRef.current = [];
      if (connectedRef.current) {
        // The bridge drives the twin through telemetry (and may aim the prop gestures at a
        // «Reconocer» measurement): playing the fixed local choreography too would make it twitch.
        return sendToBridge(`gesture ${gesture}`, (c) => c.triggerGesture(gesture, mood));
      }

      // Same multi-step choreography as the bridge (generated from gestures.rs), so the
      // browser-only twin performs the whole gesture instead of jumping to one pose.
      abortLocalScan('interrupted');
      const canonical = GESTURE_ALIASES[gesture.trim().toLowerCase()] ?? 'home';
      const choreo = GESTURES[canonical];
      const scene = LOCAL_GESTURE_SCENE[canonical] ?? {};
      // Prop gestures aim joint1 at a fresh simulated «Reconocer», exactly like the bridge (aim_for /
      // aim_gesture); without one they keep the fixed side.
      let steps = choreo.steps;
      let aimNote = '';
      const aimDef = AIM_OBJECTS[canonical];
      if (aimDef) {
        const [object, defaultJ1] = aimDef;
        const now = telemetryRef.current;
        const aim = now.scan_env ? aimFor(now.scan_env, object, now.odometry, Date.now()) : null;
        if (aim?.ok) {
          steps = aimSteps(canonical, choreo.steps, aim.joint1);
          aimNote = describeAim({
            source: 'measured',
            object,
            joint1: aim.joint1,
            bearing_deg: Math.round((Math.atan2(aim.y_m, aim.x_m) * 1800) / Math.PI) / 10,
            distance_m: Math.round(Math.hypot(aim.x_m, aim.y_m) * 1000) / 1000,
            confidence: aim.confidence,
            reason: null,
          });
        } else {
          aimNote = describeAim({
            source: 'default',
            object,
            joint1: defaultJ1,
            bearing_deg: null,
            distance_m: null,
            confidence: null,
            reason: aim && !aim.ok ? aim.reason : 'no_scan',
          });
        }
      }
      let delayMs = 0;
      let velocity: [number, number, number] = [0, 0, 0];
      steps.forEach((step, index) => {
        if (step.velocity) velocity = step.velocity;
        const held = velocity;
        const timer = setTimeout(() => {
          setTelemetry((prev) => {
            const servos = { ...prev.servos };
            SERVO_IDS.forEach((id, i) => {
              servos[id] = step.servos[i];
            });
            const blockedForward = prev.lidar.front_m < 0.28 && held[0] > 0;
            const applied: [number, number, number] = blockedForward ? [0, held[1], held[2]] : held;
            const odometry = integrateOdometry(prev.odometry, applied, step.durationMs / 1000);
            return {
              ...prev,
              servos,
              odometry,
              ...(prev.scan_env ? { scan_env: refreshScan(prev.scan_env, odometry, Date.now()) } : {}),
              rgb: choreo.rgb,
              active_gesture: canonical,
              mood,
              ...(index === 0 && scene.pointed_totem !== undefined
                ? { pointed_totem: scene.pointed_totem }
                : {}),
              ...(index === 0 && canonical !== 'trash_toss' && scene.held_object
                ? { held_object: scene.held_object }
                : {}),
              // trash_toss drops the object only once the gripper opens (pulse < 320), as in the bridge.
              ...(canonical === 'trash_toss' && step.servos[5] < 320
                ? { held_object: 'released_rejected' }
                : {}),
            };
          });
        }, delayMs);
        choreoTimersRef.current.push(timer);
        delayMs += step.durationMs;
      });
      const stopTimer = setTimeout(() => {
        setTelemetry((prev) => ({ ...prev, odometry: { ...prev.odometry, vx: 0, vy: 0, wz: 0 } }));
      }, delayMs);
      choreoTimersRef.current.push(stopTimer);
      const result = await sendToBridge(`gesture ${gesture}`, (c) => c.triggerGesture(gesture, mood));
      return aimNote && result.target === 'simulator' && result.ok
        ? { ...result, message: `${result.message} ${aimNote}` }
        : result;
    },
    [sendToBridge, abortLocalScan]
  );

  /**
   * «Reconocer»: with a bridge (robot or mock) it asks the bridge to sweep the arm and measure where
   * the props are. Without one (or if it does not answer) the twin simulates the same sweep: same
   * poses and durations, a simulated camera that only sees the props inside its cone, and the same
   * merge of the views (scene-scan-sim.ts).
   */
  const startSceneScan = useCallback(
    async (scene: ScanScene): Promise<RobotActionResult> => {
      if (connectedRef.current || authErrorRef.current) {
        return sendToBridge(`scan_env ${scene}`, (c) => c.startSceneScan(scene));
      }
      if (scanTimersRef.current.length > 0) {
        return { ok: false, target: 'simulator', code: 'scan_running', message: 'Ya hay un Reconocer en curso.' };
      }
      // Like the bridge, the sweep takes over the arm: a pending gesture stops here.
      for (const t of choreoTimersRef.current) clearTimeout(t);
      choreoTimersRef.current = [];
      setTelemetry((prev) => ({
        ...prev,
        scan_env: runningScan(scene, Date.now()),
        active_gesture: 'scan_env',
        pointed_totem: null,
        odometry: { ...prev.odometry, vx: 0, vy: 0, wz: 0 },
      }));
      const captures: CaptureDetection[][] = [];
      const { keyframes, totalMs } = sweepTimeline();
      const schedule = (atMs: number, fn: () => void) => {
        scanTimersRef.current.push(setTimeout(fn, atMs));
      };
      for (const kf of keyframes) {
        schedule(kf.atMs, () => {
          if (kf.captureStep !== null) {
            const step = kf.captureStep;
            // Indexed by pause, so a repeated call never counts a view twice
            captures[step - 1] = simCapture(scene, DEFAULT_SIM_SCENE, telemetryRef.current.odometry, kf.j1);
            setTelemetry((prev) =>
              prev.scan_env?.state === 'running' ? { ...prev, scan_env: { ...prev.scan_env, step } } : prev
            );
            return;
          }
          setTelemetry((prev) => {
            const servos = { ...prev.servos };
            for (const [id, pulse] of Object.entries(kf.servos)) servos[id] = clampServoForHardware(Number(id), pulse);
            return { ...prev, servos };
          });
        });
      }
      schedule(totalMs, () => {
        scanTimersRef.current = [];
        setTelemetry((prev) => {
          if (prev.scan_env?.state !== 'running') return prev;
          const now = Date.now();
          const odom = prev.odometry;
          const done = refreshScan(
            {
              ...prev.scan_env,
              state: 'done',
              finished_at_ms: now,
              detections: aggregate(scene, captures.filter(Boolean)),
              odom_at_scan: { x_m: odom.x_m, y_m: odom.y_m, yaw_rad: odom.yaw_rad },
              stale_reason: null,
            },
            odom,
            now
          );
          return { ...prev, scan_env: done, active_gesture: prev.active_gesture === 'scan_env' ? 'home' : prev.active_gesture };
        });
      });
      return {
        ok: true,
        target: 'simulator',
        message: 'Reconocer simulado en el gemelo: el brazo barre y una cámara simulada busca los objetos.',
      };
    },
    [sendToBridge]
  );

  const resetScene = useCallback(async () => {
    for (const t of scanTimersRef.current) clearTimeout(t);
    scanTimersRef.current = [];
    setTelemetry(FALLBACK_TELEMETRY);
    return sendToBridge('scene/reset', (c) => c.resetScene());
  }, [sendToBridge]);

  /**
   * Latches the E-stop on the bridge (`POST /stop`). Unlike other actions it is
   * sent whenever the bridge is enabled, even if the telemetry WebSocket is down
   * or the last request was a 401: the HTTP route may still be reachable.
   */
  const emergencyStop = useCallback(async (): Promise<RobotActionResult> => {
    // The local twin stops too (pending choreography steps, a simulated «Reconocer» and chassis velocity).
    for (const t of choreoTimersRef.current) clearTimeout(t);
    choreoTimersRef.current = [];
    abortLocalScan('estop');
    setTelemetry((prev) => ({ ...prev, odometry: { ...prev.odometry, vx: 0, vy: 0, wz: 0 } }));

    const client = bridgeRef.current;
    if (!client || !isBridgeEnabled()) return SIMULATOR_ONLY;
    try {
      await client.emergencyStop();
      setBridge((prev) => ({ ...prev, estopLatched: true }));
      return { ok: true, target: 'robot', message: 'STOP enviado al robot.' };
    } catch (err) {
      const { code, message } = describeBridgeError(err);
      console.warn(`[robot] stop falló (${code}): ${message}`);
      if (code === 'estop_latched') {
        setBridge((prev) => (prev.estopLatched ? prev : { ...prev, estopLatched: true }));
        return { ok: true, target: 'robot', message: 'El STOP ya estaba activo.' };
      }
      if (code === 'worker_dead') {
        // The bridge accepted /stop and latched the E-stop, but the robot driver is not answering.
        setBridge((prev) => (prev.estopLatched ? prev : { ...prev, estopLatched: true }));
        return {
          ok: true,
          target: 'robot',
          message: 'STOP enviado, pero el control del robot no responde: si sigue moviéndose, apágalo.',
        };
      }
      return { ok: false, target: 'robot', code, message };
    }
  }, [abortLocalScan]);

  /** Releases a latched E-stop (`POST /estop/release`). */
  const releaseEstop = useCallback(async () => {
    const result = await sendToBridge('estop/release', (c) => c.releaseEstop());
    if (result.ok && result.target === 'robot') {
      setBridge((prev) => ({ ...prev, estopLatched: false }));
    }
    return result;
  }, [sendToBridge]);

  return {
    telemetry,
    bridge,
    bridgeConnected: bridge.connected,
    bridgeRef,
    client: bridgeRef.current,
    jogServo,
    setServoPulse,
    moveChassis,
    simulateLidar,
    triggerGesture,
    startSceneScan,
    resetScene,
    emergencyStop,
    releaseEstop,
  };
}

export type RobotLink = ReturnType<typeof useRobotTelemetry>;
