'use client';

import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { TopNav } from '@/components/TopNav';
import { GeminiLiveConsole } from '@/components/GeminiLiveConsole';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import { analyzeGitHubRepo } from '@/lib/repo-analyzer';
import { EmbodiedGeminiLiveSession } from '@/lib/gemini-live';

const Rosorin3DViewer = dynamic(
  () => import('@/components/Rosorin3DViewer').then((m) => m.Rosorin3DViewer),
  { ssr: false }
);

const PRESET_REPOS = [
  'facebook/react',
  'vercel/next.js',
  'denoland/deno',
  'ykro/rosorin-jsconf',
];

const FOLLOW_UP_QUESTIONS = [
  'Dame más detalles técnicos de lo que encontraste en el repositorio.',
  '¿Cuál es el problema más crítico y cómo me recomiendas arreglarlo?',
  'Ya agregué pruebas automatizadas E2E y rollback limpio, ¿qué opinas ahora?',
];

export default function RepoRoasterDemoPage() {
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
  const [repoInput, setRepoInput] = useState('facebook/react');
  const [analyzing, setAnalyzing] = useState(false);
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

    return () => {
      session.stopContinuousConversation();
    };
  }, [triggerGesture, moveChassis]);

  const handleAnalyzeAndRoast = async () => {
    if (!repoInput.trim()) return;
    setAnalyzing(true);
    try {
      const result = await analyzeGitHubRepo(repoInput);
      await liveSessionRef.current?.roastRepo(result);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleBargeIn = async (text: string) => {
    await liveSessionRef.current?.sendUserDefense(text);
  };

  const controlsColumn = (
    <div className="flex flex-col gap-5">
      {/* 1. Simple Repo Input */}
      <div className="rounded-2xl border border-[#DADCE0] bg-white p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full bg-[#1A73E8]" />
            <h1 className="text-xl font-bold text-[#202124]">Demo A · Repo Roaster</h1>
          </div>
          <button
            type="button"
            onClick={resetScene}
            className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3.5 py-2 text-xs font-bold text-[#202124] hover:border-[#1A73E8] hover:text-[#1A73E8]"
          >
            Posición Inicial
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAnalyzeAndRoast();
          }}
          className="mt-4 flex flex-col gap-3"
        >
          <input
            type="text"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/repo o URL de GitHub"
            className="w-full rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-4 py-3 text-base font-medium text-[#202124] focus:border-[#1A73E8] focus:bg-white focus:outline-none"
          />
          <button
            type="submit"
            disabled={analyzing}
            className="w-full rounded-xl bg-[#1A73E8] px-6 py-3.5 text-base font-bold text-white transition-colors hover:bg-[#1557B0] disabled:opacity-50"
          >
            {analyzing ? 'Analizando...' : 'Analizar y Roastear'}
          </button>
        </form>

        <div className="mt-3 flex flex-wrap gap-2">
          {PRESET_REPOS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRepoInput(r)}
              className={`rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                repoInput === r
                  ? 'border-[#1A73E8] bg-[#E8F0FE] text-[#1A73E8]'
                  : 'border-[#DADCE0] bg-[#F8F9FA] text-[#202124] hover:border-[#1A73E8]'
              }`}
            >
              {r}
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
        placeholderHeadline="Selecciona un repositorio y presiona Analizar y Roastear para iniciar la conversación."
        quickQuestions={FOLLOW_UP_QUESTIONS}
        onSendBargeIn={handleBargeIn}
        onStopContinuous={() => liveSessionRef.current?.stopContinuousConversation()}
        onInterruptSpeech={() => liveSessionRef.current?.interruptRobotSpeech()}
      />
    </div>
  );

  if (isLite) {
    return (
      <div className="flex min-h-screen w-screen flex-col bg-[#F4F3EF] text-[#111215]">
        <TopNav bridgeConnected={bridgeConnected} liteMode={true} />
        <main className="mx-auto w-full max-w-2xl flex-1 p-6">{controlsColumn}</main>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#F4F3EF] text-[#111215]">
      <TopNav bridgeConnected={bridgeConnected} />
      <main className="flex h-[calc(100vh-48px)] w-full overflow-hidden">
        <aside className="flex w-[460px] shrink-0 flex-col overflow-y-auto border-r border-[#DFDDD4] bg-[#F4F3EF] p-4">
          {controlsColumn}
        </aside>
        <section className="flex flex-1 flex-col overflow-hidden">
          <Rosorin3DViewer
            telemetry={telemetry}
            sceneMode="roaster"
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
