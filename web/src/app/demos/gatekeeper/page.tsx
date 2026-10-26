'use client';

import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { TopNav } from '@/components/TopNav';
import { GeminiLiveConsole } from '@/components/GeminiLiveConsole';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import { analyzeGitHubPR } from '@/lib/repo-analyzer';
import { EmbodiedGeminiLiveSession } from '@/lib/gemini-live';

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

export default function GatekeeperDemoPage() {
  const {
    telemetry,
    bridgeConnected,
    jogServo,
    moveChassis,
    simulateLidar,
    triggerGesture,
    resetScene,
  } = useRobotTelemetry();

  const [isLite, setIsLite] = useState(
    process.env.NEXT_PUBLIC_LITE_MODE === '1'
  );
  const [prUrlInput, setPrUrlInput] = useState(PRESET_PR_LINKS[0].url);
  const [evaluating, setEvaluating] = useState(false);
  const [conversationActive, setConversationActive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<'idle' | 'connecting' | 'live' | 'rehearsal_voice'>('idle');
  const [speaking, setSpeaking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micWarning, setMicWarning] = useState<string | null>(null);
  const [userTranscript, setUserTranscript] = useState('');
  const [verdictHeadline, setVerdictHeadline] = useState<string>('');

  const liveSessionRef = useRef<EmbodiedGeminiLiveSession | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('lite') === '1' || process.env.NEXT_PUBLIC_LITE_MODE === '1') {
        setIsLite(true);
      } else {
        window.localStorage.removeItem('ROSORIN_LITE_MODE');
        setIsLite(false);
      }
    }
  }, []);

  useEffect(() => {
    const session = new EmbodiedGeminiLiveSession(
      { triggerGesture, moveChassis },
      {
        onStatus: (st) => setLiveStatus(st),
        onTranscript: (role, text) => {
          if (role === 'robot' && text.trim()) {
            setVerdictHeadline(text);
          } else if (role === 'user' && text.trim()) {
            setUserTranscript(text);
          }
        },
        onVerdictHeadline: (headline) => {
          if (headline) setVerdictHeadline(headline);
        },
        onSpeakingChange: (sp) => setSpeaking(sp),
        onConversationActiveChange: (act) => setConversationActive(act),
        onMicLevelChange: (lvl) => setMicLevel(lvl),
        onMicWarning: (warn) => setMicWarning(warn),
      }
    );
    liveSessionRef.current = session;
    triggerGesture('gatekeeper_hold', 'guarding');

    return () => {
      session.stopContinuousConversation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleHoldAgain = async () => {
    await triggerGesture('gatekeeper_hold', 'guarding');
    setVerdictHeadline('Llave sujeta nuevamente en la pinza.');
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
              onClick={handleHoldAgain}
              className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3.5 py-2 text-xs font-bold text-[#202124] hover:border-[#1A73E8] hover:text-[#1A73E8]"
            >
              Sujetar Llave
            </button>
          </div>
        </div>

        <form onSubmit={handleEvaluatePr} className="mt-4 flex flex-col gap-3">
          <input
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
              onClick={() => setPrUrlInput(item.url)}
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
      </div>

      {/* 2. Gemini Live Voice & Follow-up Conversation */}
      <GeminiLiveConsole
        status={liveStatus}
        speaking={speaking}
        externalActive={conversationActive}
        micLevel={micLevel}
        micWarning={micWarning}
        userTranscript={userTranscript}
        verdictHeadline={verdictHeadline}
        placeholderHeadline="Selecciona un Pull Request de GitHub y pulsa Evaluar PR para iniciar la conversación."
        quickQuestions={FOLLOW_UP_QUESTIONS}
        onSendBargeIn={(text) => liveSessionRef.current?.sendUserDefense(text)}
        onStopContinuous={() => liveSessionRef.current?.stopContinuousConversation()}
        onInterruptSpeech={() => liveSessionRef.current?.interruptRobotSpeech()}
      />
    </div>
  );

  if (isLite) {
    return (
      <div className="flex min-h-screen w-screen flex-col bg-[#F8F9FA] text-[#202124]">
        <TopNav bridgeConnected={bridgeConnected} liteMode={true} />
        <main className="mx-auto w-full max-w-2xl flex-1 p-6">{controlsColumn}</main>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#F8F9FA] text-[#202124]">
      <TopNav bridgeConnected={bridgeConnected} />
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
            onWebcamFrame={(b64) => liveSessionRef.current?.sendWebcamFrameBase64(b64)}
            onTriggerGesture={(g) => triggerGesture(g, 'manual')}
            onResetScene={resetScene}
          />
        </section>
      </main>
    </div>
  );
}
