'use client';

import React, { useRef, useState } from 'react';
import type { TelemetryState } from '@/lib/types';

interface HardwareControlPanelProps {
  telemetry: TelemetryState;
  sceneMode?: 'default' | 'roaster' | 'gatekeeper' | 'bughunter';
  onJogServo?: (id: number, delta: number) => void;
  onSetServoPulse?: (id: number, pulse: number) => void;
  onMoveChassis?: (vx: number, vy: number, wz: number) => void;
  onTriggerGesture?: (gesture: string) => void;
  onResetScene?: () => void;
}

const SERVO_AXES = [
  { id: 1, name: 'Base (Giro)', min: 120, max: 880 },
  { id: 2, name: 'Hombro', min: 220, max: 780 },
  { id: 3, name: 'Codo', min: 150, max: 850 },
  { id: 4, name: 'Muñeca Arriba/Abajo', min: 150, max: 850 },
  { id: 5, name: 'Muñeca Giro', min: 100, max: 900 },
  { id: 10, name: 'Pinza', min: 200, max: 750 },
];

/** `key` must match the keyboard handlers in Rosorin3DViewer and /robot (F, G, H, V). */
const GESTURE_PRESETS: Array<{ id: string; label: string; key?: string }> = [
  { id: 'wave_hello', label: 'Wave Hello' },
  { id: 'facepalm', label: 'Facepalm', key: 'F' },
  { id: 'trash_toss', label: 'Trash Toss', key: 'G' },
  { id: 'chef_kiss', label: 'Chef Kiss', key: 'H' },
  { id: 'victory_spin', label: 'Victory Spin', key: 'V' },
  { id: 'suspicious_inspect', label: 'Suspicious Inspect' },
];

export function HardwareControlPanel({
  telemetry,
  onJogServo,
  onSetServoPulse,
  onMoveChassis,
  onTriggerGesture,
  onResetScene,
}: HardwareControlPanelProps) {
  const [localSliders, setLocalSliders] = useState<Record<number, number>>({});
  const lastSentRef = useRef<Record<number, number>>({});

  const getServoValue = (id: number): number => {
    if (localSliders[id] !== undefined) return localSliders[id];
    const target = telemetry.target_servos?.[String(id)];
    if (target !== undefined) return target;
    return telemetry.servos?.[String(id)] ?? 500;
  };

  const applyServoAbsolute = (id: number, nextPulse: number, force = false) => {
    const clamped = Math.round(nextPulse);
    setLocalSliders((prev) => ({ ...prev, [id]: clamped }));
    const now = Date.now();
    if (!force && now - (lastSentRef.current[id] || 0) < 80) {
      return;
    }
    lastSentRef.current[id] = now;
    if (onSetServoPulse) {
      onSetServoPulse(id, clamped);
    } else if (onJogServo) {
      const cur = telemetry.servos?.[String(id)] ?? 500;
      onJogServo(id, clamped - cur);
    }
  };

  return (
    <div className="flex flex-col gap-5 text-[#202124]">
      {/* Balanced 2-Column Hardware Studio Grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* LEFT COLUMN (7 cols): 6-DOF Arm & Gripper Sliders */}
        <section className="flex flex-col justify-between rounded-2xl border border-[#DADCE0] bg-white p-5 shadow-xs lg:col-span-7">
          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[#F1F3F4] pb-3">
              <div className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-full bg-[#1A73E8]" />
                <h2 className="font-display text-lg font-bold text-[#202124]">
                  Control del Brazo y Pinza
                </h2>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => applyServoAbsolute(10, 220, true)}
                  className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3.5 py-2 text-xs font-bold text-[#202124] transition-colors hover:border-[#1A73E8] hover:bg-[#E8F0FE] hover:text-[#1A73E8] active:scale-95"
                >
                  Abrir Pinza
                </button>
                <button
                  type="button"
                  onClick={() => applyServoAbsolute(10, 680, true)}
                  className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3.5 py-2 text-xs font-bold text-[#202124] transition-colors hover:border-[#1A73E8] hover:bg-[#E8F0FE] hover:text-[#1A73E8] active:scale-95"
                >
                  Cerrar Pinza
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLocalSliders({});
                    onResetScene?.();
                  }}
                  className="rounded-xl bg-[#1A73E8] px-3.5 py-2 text-xs font-bold text-white transition-colors hover:bg-[#1557B0] active:scale-95"
                >
                  Posición Inicial
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
              {SERVO_AXES.map((ax) => {
                const val = getServoValue(ax.id);
                return (
                  <div
                    key={ax.id}
                    className="flex flex-col gap-2.5 rounded-xl border border-[#DADCE0] bg-[#F8F9FA] p-3.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold text-[#202124]">{ax.name}</span>
                      <span className="rounded-md bg-[#E8F0FE] px-2.5 py-0.5 font-mono text-xs font-bold text-[#1A73E8]">
                        {val}
                      </span>
                    </div>

                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() =>
                          applyServoAbsolute(ax.id, Math.max(ax.min, val - 45), true)
                        }
                        aria-label={`${ax.name}: menos`}
                        className="flex h-10 w-12 shrink-0 items-center justify-center rounded-xl border border-[#DADCE0] bg-white font-mono text-base font-bold text-[#202124] transition-colors hover:border-[#1A73E8] hover:text-[#1A73E8] active:bg-[#E8F0FE]"
                      >
                        −
                      </button>
                      <input
                        type="range"
                        aria-label={`${ax.name} (servo ${ax.id})`}
                        min={ax.min}
                        max={ax.max}
                        value={val}
                        onChange={(e) => applyServoAbsolute(ax.id, Number(e.target.value), false)}
                        onMouseUp={(e) =>
                          applyServoAbsolute(
                            ax.id,
                            Number((e.target as HTMLInputElement).value),
                            true
                          )
                        }
                        onTouchEnd={(e) =>
                          applyServoAbsolute(
                            ax.id,
                            Number((e.target as HTMLInputElement).value),
                            true
                          )
                        }
                        className="h-2.5 flex-1 cursor-pointer accent-[#1A73E8]"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          applyServoAbsolute(ax.id, Math.min(ax.max, val + 45), true)
                        }
                        aria-label={`${ax.name}: más`}
                        className="flex h-10 w-12 shrink-0 items-center justify-center rounded-xl border border-[#DADCE0] bg-white font-mono text-base font-bold text-[#202124] transition-colors hover:border-[#1A73E8] hover:text-[#1A73E8] active:bg-[#E8F0FE]"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN (5 cols): Mecanum Wheels D-Pad + Expressive Gestures */}
        <div className="flex flex-col gap-5 lg:col-span-5">
          {/* 1. Mecanum D-Pad */}
          <section className="rounded-2xl border border-[#DADCE0] bg-white p-5 shadow-xs">
            <div className="mb-3 flex items-center justify-between border-b border-[#F1F3F4] pb-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-full bg-[#34A853]" />
                <h2 className="font-display text-lg font-bold text-[#202124]">
                  Mover Ruedas
                </h2>
              </div>
              <span className="font-mono text-xs text-[#5F6368]">Flechas ↑↓←→</span>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <button
                type="button"
                onClick={() => onMoveChassis?.(0, 0, 0.45)}
                className="h-12 rounded-xl border border-[#DADCE0] bg-[#F8F9FA] text-sm font-bold text-[#202124] transition-colors hover:border-[#1A73E8] hover:bg-[#E8F0FE] hover:text-[#1A73E8] active:scale-95"
              >
                Giro Izq
              </button>
              <button
                type="button"
                onClick={() => onMoveChassis?.(0.15, 0, 0)}
                className="h-12 rounded-xl bg-[#1A73E8] text-sm font-bold text-white transition-colors hover:bg-[#1557B0] active:scale-95"
              >
                ↑ Adelante
              </button>
              <button
                type="button"
                onClick={() => onMoveChassis?.(0, 0, -0.45)}
                className="h-12 rounded-xl border border-[#DADCE0] bg-[#F8F9FA] text-sm font-bold text-[#202124] transition-colors hover:border-[#1A73E8] hover:bg-[#E8F0FE] hover:text-[#1A73E8] active:scale-95"
              >
                Giro Der
              </button>

              <button
                type="button"
                onClick={() => onMoveChassis?.(0, 0.15, 0)}
                className="h-12 rounded-xl bg-[#1A73E8] text-sm font-bold text-white transition-colors hover:bg-[#1557B0] active:scale-95"
              >
                ← Izquierda
              </button>
              <button
                type="button"
                onClick={() => onMoveChassis?.(0, 0, 0)}
                className="h-12 rounded-xl bg-[#D93025] text-sm font-bold text-white transition-colors hover:bg-[#B3261E] active:scale-95"
              >
                Alto
              </button>
              <button
                type="button"
                onClick={() => onMoveChassis?.(0, -0.15, 0)}
                className="h-12 rounded-xl bg-[#1A73E8] text-sm font-bold text-white transition-colors hover:bg-[#1557B0] active:scale-95"
              >
                Derecha →
              </button>

              <div />
              <button
                type="button"
                onClick={() => onMoveChassis?.(-0.15, 0, 0)}
                className="h-12 rounded-xl bg-[#1A73E8] text-sm font-bold text-white transition-colors hover:bg-[#1557B0] active:scale-95"
              >
                ↓ Atrás
              </button>
              <div />
            </div>
          </section>

          {/* 2. Expressive Gestures */}
          <section className="flex-1 rounded-2xl border border-[#DADCE0] bg-white p-5 shadow-xs">
            <div className="mb-3 flex items-center justify-between border-b border-[#F1F3F4] pb-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-full bg-[#FBBC04]" />
                <h2 className="font-display text-lg font-bold text-[#202124]">
                  Gestos del Robot
                </h2>
              </div>
              <span className="font-mono text-xs text-[#5F6368]">Atajos F / G / H / V</span>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {GESTURE_PRESETS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onTriggerGesture?.(g.id)}
                  className="flex h-12 items-center justify-between rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-4 text-sm font-bold text-[#202124] transition-all hover:border-[#1A73E8] hover:bg-[#E8F0FE] hover:text-[#1A73E8] active:scale-95"
                >
                  <span>{g.label}</span>
                  {g.key && (
                    <kbd
                      aria-label={`Atajo: tecla ${g.key}`}
                      className="rounded border border-[#DADCE0] bg-white px-1.5 py-0.5 font-mono text-xs text-[#5F6368]"
                    >
                      {g.key}
                    </kbd>
                  )}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
