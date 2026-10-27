'use client';

import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { TopNav } from '@/components/TopNav';
import { GeminiLiveConsole } from '@/components/GeminiLiveConsole';
import { ApiKeyGate } from '@/components/ApiKeyGate';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import { useEmbodiedLiveSession } from '@/lib/use-embodied-live-session';
import { SYSTEM_PROMPT_EN } from '@/lib/gemini-live';
import { buildRoasterSystemPrompt } from '@/lib/prompts/roaster';
import { useLiteMode } from '@/lib/use-lite-mode';
import { analyzeGitHubRepo } from '@/lib/repo-analyzer';

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

// Every turn of the Roaster's conversation uses the acid persona (web/src/lib/prompts/roaster.ts)
const ROASTER_SYSTEM_PROMPT = buildRoasterSystemPrompt(SYSTEM_PROMPT_EN);

const FOLLOW_UP_QUESTIONS = [
  'Dame más detalles técnicos de lo que encontraste en el repositorio.',
  '¿Cuál es el problema más crítico y cómo me recomiendas arreglarlo?',
  'Ya agregué pruebas automatizadas E2E y rollback limpio, ¿qué opinas ahora?',
];

export default function RepoRoasterDemoPage() {
  const robot = useRobotTelemetry();
  const { telemetry, jogServo, moveChassis, simulateLidar, triggerGesture, resetScene } = robot;
  const isLite = useLiteMode();
  const [repoInput, setRepoInput] = useState('facebook/react');
  const [analyzing, setAnalyzing] = useState(false);
  const { sessionRef: liveSessionRef, consoleProps } = useEmbodiedLiveSession(robot, undefined, {
    systemPrompt: ROASTER_SYSTEM_PROMPT,
  });

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

        {/* Without a Gemini key only the key prompt is shown here */}
        <div className="mt-4">
        <ApiKeyGate>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAnalyzeAndRoast();
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor="roaster-repo-input" className="text-xs font-bold text-[#5F6368]">
            Repositorio de GitHub
          </label>
          <input
            id="roaster-repo-input"
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
        </ApiKeyGate>
        </div>
      </div>

      {/* 2. Gemini Live Voice & Follow-up Conversation */}
      <ApiKeyGate quiet>
        <GeminiLiveConsole
          {...consoleProps}
          placeholderHeadline="Selecciona un repositorio y presiona Analizar y Roastear para iniciar la conversación."
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
            sceneMode="roaster"
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
