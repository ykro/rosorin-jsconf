'use client';

import React, { useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { TopNav } from '@/components/TopNav';
import { GeminiLiveConsole } from '@/components/GeminiLiveConsole';
import { SceneScanPanel } from '@/components/SceneScanPanel';
import { formatBearing } from '@/lib/scene-scan';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import { useEmbodiedLiveSession } from '@/lib/use-embodied-live-session';
import { useLiteMode } from '@/lib/use-lite-mode';
import { analyzeGitHubIncident } from '@/lib/repo-analyzer';

const Rosorin3DViewer = dynamic(
  () => import('@/components/Rosorin3DViewer').then((m) => m.Rosorin3DViewer),
  { ssr: false }
);

const PRESET_INCIDENT_LINKS = [
  {
    url: 'https://github.com/acme-cloud/cloud-run-worker/issues/542',
    label: 'acme-cloud/cloud-run-worker#542 (Cloud Run · OOM)',
  },
  {
    url: 'https://github.com/acme-cloud/voice-stream/issues/142',
    label: 'acme-cloud/voice-stream#142 (Gemini Live · Audio PCM)',
  },
  {
    url: 'https://github.com/acme-cloud/firestore-orders/issues/798',
    label: 'acme-cloud/firestore-orders#798 (Firestore · Índice)',
  },
];

const TOTEM_DETAILS: Record<
  'cloud_run' | 'gemini_live' | 'firestore',
  { name: string; position: string; color: string }
> = {
  cloud_run: {
    name: 'CLOUD RUN',
    position: 'Tótem Izquierdo (Azul)',
    color: '#1A73E8',
  },
  gemini_live: {
    name: 'GEMINI LIVE',
    position: 'Tótem Central (Verde)',
    color: '#1E8E3E',
  },
  firestore: {
    name: 'FIRESTORE',
    position: 'Tótem Derecho (Amarillo)',
    color: '#F9AB00',
  },
};

const FOLLOW_UP_QUESTIONS = [
  'Explícame con más detalle por qué falló ese servicio y cuál fue la causa raíz.',
  '¿Cómo corrijo exactamente este problema en el código paso a paso?',
  '¿Por qué descartaste a los otros dos servicios de la arquitectura?',
];

export default function BugHunterDemoPage() {
  const robot = useRobotTelemetry();
  const { telemetry, jogServo, moveChassis, simulateLidar, triggerGesture, resetScene, startSceneScan } = robot;
  const isLite = useLiteMode();
  const [incidentInput, setIncidentInput] = useState(PRESET_INCIDENT_LINKS[0].url);
  const [hunting, setHunting] = useState(false);
  const [identifiedTotem, setIdentifiedTotem] = useState<'cloud_run' | 'gemini_live' | 'firestore' | null>(null);

  const onVerdictGesture = useCallback((gesture: string) => {
    if (gesture === 'point_cloud_run') setIdentifiedTotem('cloud_run');
    else if (gesture === 'point_gemini_live') setIdentifiedTotem('gemini_live');
    else if (gesture === 'point_firestore') setIdentifiedTotem('firestore');
  }, []);
  const { sessionRef: liveSessionRef, consoleProps } = useEmbodiedLiveSession(robot, onVerdictGesture);

  const handleHunt = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!incidentInput.trim()) return;
    setHunting(true);
    try {
      const info = await analyzeGitHubIncident(incidentInput);
      const totem = await liveSessionRef.current?.huntProductionBug(info.incidentLog);
      if (totem) setIdentifiedTotem(totem);
    } finally {
      setHunting(false);
    }
  };

  const activeTotemInfo = identifiedTotem ? TOTEM_DETAILS[identifiedTotem] : null;
  const scan = telemetry.scan_env;
  const measuredTotem =
    identifiedTotem && scan?.state === 'done' && scan.fresh
      ? scan.detections.find((d) => d.id === identifiedTotem)
      : undefined;

  const controlsColumn = (
    <div className="flex flex-col gap-5">
      {/* 1. Simple GitHub Issue / Incident Link Selector */}
      <div className="rounded-2xl border border-[#DADCE0] bg-white p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full bg-[#F9AB00]" />
            <h1 className="text-xl font-bold text-[#202124]">Demo C · Bug Hunter</h1>
          </div>
          <button
            type="button"
            onClick={() => {
              setIdentifiedTotem(null);
              resetScene();
            }}
            className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3.5 py-2 text-xs font-bold text-[#202124] hover:border-[#1A73E8] hover:text-[#1A73E8]"
          >
            Centrar Robot
          </button>
        </div>

        <form onSubmit={handleHunt} className="mt-4 flex flex-col gap-3">
          <label htmlFor="bughunter-issue-input" className="text-xs font-bold text-[#5F6368]">
            Issue de GitHub con el incidente
          </label>
          <input
            id="bughunter-issue-input"
            type="text"
            value={incidentInput}
            onChange={(e) => setIncidentInput(e.target.value)}
            placeholder="https://github.com/owner/repo/issues/123"
            className="w-full rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-4 py-3 text-base font-medium text-[#202124] focus:border-[#1A73E8] focus:bg-white focus:outline-none"
          />
          <button
            type="submit"
            disabled={hunting || !incidentInput.trim()}
            className="w-full rounded-xl bg-[#1A73E8] px-6 py-3.5 text-base font-bold text-white transition-colors hover:bg-[#1557B0] disabled:opacity-50"
          >
            {hunting ? 'Diagnosticando...' : 'Diagnosticar y Señalar'}
          </button>
        </form>

        {/* 3 Clickable GitHub Issue Links */}
        <div className="mt-3 flex flex-wrap gap-2">
          {PRESET_INCIDENT_LINKS.map((item) => (
            <button
              key={item.url}
              type="button"
              onClick={() => setIncidentInput(item.url)}
              className={`rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                incidentInput === item.url
                  ? 'border-[#1A73E8] bg-[#E8F0FE] text-[#1A73E8]'
                  : 'border-[#DADCE0] bg-[#F8F9FA] text-[#202124] hover:border-[#1A73E8]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {activeTotemInfo && (
          <div className="mt-4 flex items-center justify-between rounded-xl border border-[#DADCE0] bg-[#F8F9FA] p-4">
            <span className="text-base font-bold text-[#202124]">
              {activeTotemInfo.name}
            </span>
            <span
              className="rounded-lg px-3 py-1.5 text-xs font-bold text-white"
              style={{ backgroundColor: activeTotemInfo.color }}
            >
              {measuredTotem ? `Medido · ${formatBearing(measuredTotem.bearing_deg)}` : activeTotemInfo.position}
            </span>
          </div>
        )}
      </div>

      {/* «Reconocer»: where the totems really are (the arm points there) */}
      <SceneScanPanel
        scene="bughunter"
        telemetry={telemetry}
        bridgeConnected={robot.bridge.connected}
        estopLatched={robot.bridge.estopLatched}
        onStart={startSceneScan}
      />

      {/* 2. Gemini Live Voice & Follow-up Conversation */}
      <GeminiLiveConsole
        {...consoleProps}
        placeholderHeadline="Selecciona un Issue de GitHub y pulsa Diagnosticar y Señalar para conversar."
        quickQuestions={FOLLOW_UP_QUESTIONS}
      />
    </div>
  );

  if (isLite) {
    return (
      <div className="flex min-h-screen w-screen flex-col bg-[#F8F9FA] text-[#202124]">
        <TopNav robot={robot} liteMode={true} />
        <main className="mx-auto w-full max-w-2xl flex-1 p-6">{controlsColumn}</main>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#F8F9FA] text-[#202124]">
      <TopNav robot={robot} />
      <main className="flex h-[calc(100vh-56px)] w-full overflow-hidden">
        <aside className="flex w-[460px] shrink-0 flex-col overflow-y-auto border-r border-[#DADCE0] bg-[#F8F9FA] p-4">
          {controlsColumn}
        </aside>
        <section className="flex flex-1 flex-col overflow-hidden">
          <Rosorin3DViewer
            telemetry={telemetry}
            sceneMode="bughunter"
            enableKeyboard={true}
            onJogServo={jogServo}
            onMoveChassis={moveChassis}
            onSimulateLidar={simulateLidar}
            onTriggerGesture={(g) => triggerGesture(g, 'manual')}
            onResetScene={resetScene}
          />
        </section>
      </main>
    </div>
  );
}
