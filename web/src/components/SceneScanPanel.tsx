'use client';

import React, { useState } from 'react';
import type { RobotActionResult, ScanScene, TelemetryState } from '@/lib/types';
import { scanProgress, scanResultRows } from '@/lib/scene-scan';

export interface SceneScanPanelProps {
  scene: ScanScene;
  telemetry: TelemetryState;
  /** The bridge (robot or mock) is connected: «Reconocer» needs it. */
  bridgeConnected: boolean;
  estopLatched: boolean;
  onStart: (scene: ScanScene) => Promise<RobotActionResult>;
}

const WHAT: Record<ScanScene, string> = {
  gatekeeper: 'las bandejas APROBADO y RECHAZADO',
  bughunter: 'los tótems Cloud Run, Gemini Live y Firestore',
};

/**
 * «Reconocer»: the robot sweeps only its arm with the depth camera and measures where the props are;
 * the prop gestures then aim there. Progress and result sit next to the button. STOP (or Escape)
 * aborts the sweep at any time.
 */
export function SceneScanPanel({ scene, telemetry, bridgeConnected, estopLatched, onStart }: SceneScanPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const scan = telemetry.scan_env;
  const progress = scanProgress(scan, scene);
  const rows = scanResultRows(scan, scene);
  const disabled = starting || progress.running || !bridgeConnected || estopLatched;

  const handleStart = async () => {
    setError(null);
    setStarting(true);
    try {
      const result = await onStart(scene);
      if (!result.ok) setError(result.message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[#DADCE0] bg-white p-4 shadow-xs" aria-label="Reconocer entorno">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleStart}
          disabled={disabled}
          className="rounded-xl bg-[#1A73E8] px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-[#1557B0] disabled:opacity-50"
        >
          Reconocer
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1" role="status" aria-live="polite">
          <span className="text-xs font-bold text-[#202124]">{progress.label}</span>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#F1F3F4]">
            <div className="h-full rounded-full bg-[#1A73E8]" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-[#5F6368]">
        {progress.running
          ? 'Solo se mueve el brazo, despacio. Para abortar: STOP o Escape.'
          : !bridgeConnected
            ? 'Conecta el bridge (el robot o ./run.sh --mock) para reconocer el entorno.'
            : estopLatched
              ? 'STOP activo: libéralo para reconocer el entorno.'
              : `Mide con la cámara 3D dónde están ${WHAT[scene]} (solo el brazo, sin ruedas).`}
      </p>
      {progress.detail && <p className="mt-1 text-xs font-bold text-[#B06000]">{progress.detail}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs font-bold text-[#D93025]">
          {error}
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-2 font-bold text-[#202124]">
              <span className={`h-2 w-2 rounded-full ${row.found ? 'bg-[#1E8E3E]' : 'bg-[#DADCE0]'}`} />
              {row.label}
            </span>
            <span className={row.lowConfidence ? 'font-bold text-[#B06000]' : 'text-[#5F6368]'}>{row.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
