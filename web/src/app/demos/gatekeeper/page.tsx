'use client';

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { TopNav } from '@/components/TopNav';
import { GeminiLiveConsole } from '@/components/GeminiLiveConsole';
import { SceneScanPanel } from '@/components/SceneScanPanel';
import { ApiKeyGate } from '@/components/ApiKeyGate';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import { useEmbodiedLiveSession } from '@/lib/use-embodied-live-session';
import { useLiteMode } from '@/lib/use-lite-mode';
import { analyzeGitHubPR } from '@/lib/repo-analyzer';
import { PUT_KEY_BACK_HINT, caseSwitchAction } from '@/lib/gatekeeper-case';

const Rosorin3DViewer = dynamic(
  () => import('@/components/Rosorin3DViewer').then((m) => m.Rosorin3DViewer),
  { ssr: false }
);

const PRESET_PR_LINKS = [
  {
    url: 'https://github.com/acme-cloud/edge-router/pull/289',
    label: 'acme-cloud/edge-router#289 (Rechazar · Sin tests)',
  },
  {
    url: 'https://github.com/acme-cloud/checkout-api/pull/645',
    label: 'acme-cloud/checkout-api#645 (Aprobar · Canary + E2E)',
  },
  {
    url: 'https://github.com/acme-cloud/rust-gateway/pull/234',
    label: 'acme-cloud/rust-gateway#234 (Aprobar · 100% Verde)',
  },
];

const FOLLOW_UP_QUESTIONS = [
  'Explícame en detalle por qué tomaste esa decisión con este Pull Request.',
  '¿Qué pruebas específicas necesito agregar para que apruebes el deploy?',
  'Ya agregué los tests de integración y un canary del 5%, ¿me entregas la llave?',
];

// Half-open pulse for Servo 10: just enough gap (~10 mm) to slip the folded paper key between
// the fingers without opening wide (220) or crossing the < 320 drop threshold.
const KEY_INSERT_PULSE = 470;

export default function GatekeeperDemoPage() {
  const robot = useRobotTelemetry();
  const {
    telemetry,
    jogServo,
    setServoPulse,
    moveChassis,
    simulateLidar,
    triggerGesture,
    resetScene,
    startSceneScan,
  } = robot;
  const isLite = useLiteMode();
  const [prUrlInput, setPrUrlInput] = useState(PRESET_PR_LINKS[0].url);
  const [evaluating, setEvaluating] = useState(false);
  const [keyHint, setKeyHint] = useState('');
  const { sessionRef: liveSessionRef, consoleProps, setVerdictHeadline } = useEmbodiedLiveSession(robot);

  const gripperPulse = telemetry.servos?.['10'] ?? 680;
  const isPinzaOpen = gripperPulse < 580;

  useEffect(() => {
    void triggerGesture('gatekeeper_hold', 'guarding');
    void robot.client?.updateHud({
      headline: 'DEMO B · GATEKEEPER CI/CD',
      subtext: 'Custodiando la llave de producción',
      mood: 'guarding',
    });
  }, [triggerGesture, robot.client, robot.bridge.connected]);

  const handleEvaluatePr = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!prUrlInput.trim()) return;
    setEvaluating(true);
    try {
      const info = await analyzeGitHubPR(prUrlInput);
      await liveSessionRef.current?.evaluateDeployGatekeeper(
        info.prSummary,
        info.testsPassing,
        info.justification
      );
    } finally {
      setEvaluating(false);
    }
  };

  const handleOpenGripper = async () => {
    setKeyHint('');
    const j1 = telemetry.servos?.['1'] ?? 500;
    if (Math.abs(j1 - 500) > 20) {
      await triggerGesture('home', 'attentive');
    }
    await setServoPulse(10, KEY_INSERT_PULSE, 350);
    setVerdictHeadline('Pinza entreabierta: coloca la llave de papel y pulsa Cerrar Pinza.');
  };

  const handleCloseGripper = async () => {
    setKeyHint('');
    await triggerGesture('gatekeeper_hold', 'guarding');
    setVerdictHeadline('Llave sujeta nuevamente en la pinza.');
  };

  // A new case starts clean: in mock or in the twin the key goes back to the gripper (what
  // «Cerrar Pinza» does); the real robot's key has to be put back by hand.
  const handleSelectCase = (url: string) => {
    if (url === prUrlInput) return;
    setPrUrlInput(url);
    setVerdictHeadline('');
    const action = caseSwitchAction(robot.bridge.connected, telemetry.backend, telemetry.held_object);
    setKeyHint(action === 'hint' ? PUT_KEY_BACK_HINT : '');
    if (action === 'hold') void triggerGesture('gatekeeper_hold', 'guarding');
  };

  const controlsColumn = (
    <div className="flex flex-col gap-5">
      {/* 1. Simple PR Link Input & Presets */}
      <div className="rounded-2xl border border-[#DADCE0] bg-white p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full bg-[#1E8E3E]" />
            <h1 className="text-xl font-bold text-[#202124]">Demo B · Gatekeeper CI/CD</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resetScene}
              className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3.5 py-2 text-xs font-bold text-[#202124] hover:border-[#1A73E8] hover:text-[#1A73E8]"
            >
              Centrar Robot
            </button>
            <button
              type="button"
              onClick={isPinzaOpen ? handleCloseGripper : handleOpenGripper}
              className={`rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                isPinzaOpen
                  ? 'border-[#1E8E3E] bg-[#E6F4EA] text-[#1E8E3E]'
                  : 'border-[#DADCE0] bg-[#F8F9FA] text-[#202124] hover:border-[#1A73E8] hover:text-[#1A73E8]'
              }`}
            >
              {isPinzaOpen ? 'Cerrar Pinza' : 'Abrir Pinza'}
            </button>
          </div>
        </div>

        {/* Without a Gemini key only the key prompt is shown here */}
        <div className="mt-4">
        <ApiKeyGate>
        <form onSubmit={handleEvaluatePr} className="flex flex-col gap-3">
          <label htmlFor="gatekeeper-pr-input" className="text-xs font-bold text-[#5F6368]">
            Pull Request de GitHub
          </label>
          <input
            id="gatekeeper-pr-input"
            type="text"
            value={prUrlInput}
            onChange={(e) => setPrUrlInput(e.target.value)}
            placeholder="https://github.com/owner/repo/pull/123"
            className="w-full rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-4 py-3 text-base font-medium text-[#202124] focus:border-[#1A73E8] focus:bg-white focus:outline-none"
          />
          <button
            type="submit"
            disabled={evaluating || !prUrlInput.trim()}
            className="w-full rounded-xl bg-[#1E8E3E] px-6 py-3.5 text-base font-bold text-white transition-colors hover:bg-[#137333] disabled:opacity-50"
          >
            {evaluating ? 'Evaluando...' : 'Evaluar PR'}
          </button>
        </form>

        {/* 3 Clickable GitHub PR Links */}
        <div className="mt-3 flex flex-wrap gap-2">
          {PRESET_PR_LINKS.map((item) => (
            <button
              key={item.url}
              type="button"
              onClick={() => handleSelectCase(item.url)}
              className={`rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                prUrlInput === item.url
                  ? 'border-[#1E8E3E] bg-[#E6F4EA] text-[#1E8E3E]'
                  : 'border-[#DADCE0] bg-[#F8F9FA] text-[#202124] hover:border-[#1A73E8]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {keyHint && <p className="mt-2 text-xs font-semibold text-[#B06000]">{keyHint}</p>}
        </ApiKeyGate>
        </div>
      </div>

      {/* «Reconocer»: where the trays really are (the gestures aim there) */}
      <SceneScanPanel
        scene="gatekeeper"
        telemetry={telemetry}
        bridgeConnected={robot.bridge.connected}
        estopLatched={robot.bridge.estopLatched}
        onStart={startSceneScan}
      />

      {/* 2. Gemini Live Voice & Follow-up Conversation */}
      <ApiKeyGate quiet>
        <GeminiLiveConsole
          {...consoleProps}
          placeholderHeadline="Selecciona un Pull Request de GitHub y pulsa Evaluar PR para iniciar la conversación."
          quickQuestions={FOLLOW_UP_QUESTIONS}
        />
      </ApiKeyGate>
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
            sceneMode="gatekeeper"
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
