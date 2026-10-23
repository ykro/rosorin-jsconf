'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { TopNav } from '@/components/TopNav';
import { ApiKeyCollapsible } from '@/components/ApiKeyCollapsible';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import {
  BumblebeeRadioSession,
  type RadioTurnLog,
  type SongClip,
} from '@/lib/bumblebee-radio';

const Rosorin3DViewer = dynamic(
  () => import('@/components/Rosorin3DViewer').then((m) => m.Rosorin3DViewer),
  { ssr: false }
);

const QUICK_PROMPTS = [
  '¡Hola Bumblebee! ¿Cómo estás hoy?',
  'El deploy en viernes salió perfecto a la primera.',
  'Se cayó producción y nadie sabe por qué.',
  'Cuéntame un chiste y baila con las llantas Mecanum.',
  'Te quiero mucho robotcito, gracias por todo.',
  '¿Qué opinas de la inteligencia artificial?',
];

const DANCE_PRESETS = [
  { id: 'bumblebee_hype', label: 'Hype Party', color: 'bg-[#FBBC04] text-[#202124]' },
  { id: 'bumblebee_groove', label: 'Funk Groove', color: 'bg-[#1A73E8] text-white' },
  { id: 'bumblebee_rock_out', label: 'Rock Headbang', color: 'bg-[#EA4335] text-white' },
  { id: 'bumblebee_romance', label: 'FM Romance', color: 'bg-[#E91E63] text-white' },
  { id: 'bumblebee_sassy', label: 'Sassy Spin', color: 'bg-[#34A853] text-white' },
  { id: 'bumblebee_sad_droop', label: 'Sad Violins', color: 'bg-[#5F6368] text-white' },
];

export default function BumblebeeDemoPage() {
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
  const [catalog, setCatalog] = useState<SongClip[]>([]);
  const [radioStatus, setRadioStatus] = useState<
    'idle' | 'connecting' | 'live' | 'tuning' | 'playing'
  >('idle');
  const [conversationActive, setConversationActive] = useState(false);
  const [userTranscript, setUserTranscript] = useState('');
  const [nowPlaying, setNowPlaying] = useState<SongClip | null>(null);
  const [frequencyMhz, setFrequencyMhz] = useState('104.7 FM');
  const [radioCaption, setRadioCaption] = useState(
    'Pulsa "Iniciar Conversación Musical" o elige una frase: combinará segmentos de canciones reales con embeddings semánticos y bailará.'
  );
  const [turnHistory, setTurnHistory] = useState<RadioTurnLog[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [micWarning, setMicWarning] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');

  const sessionRef = useRef<BumblebeeRadioSession | null>(null);

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
    fetch('/songs/catalog.json')
      .then((r) => r.json())
      .then((data: SongClip[]) => {
        setCatalog(data);
        sessionRef.current?.setCatalog(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const session = new BumblebeeRadioSession(
      { triggerGesture, moveChassis },
      {
        onStatus: (st) => setRadioStatus(st),
        onConversationActiveChange: (act) => setConversationActive(act),
        onUserTranscript: (txt) => setUserTranscript(txt),
        onNowPlaying: (clip, freq, cap) => {
          setNowPlaying(clip);
          setFrequencyMhz(freq);
          if (cap) setRadioCaption(cap);
        },
        onTurnLog: (turn) => {
          setTurnHistory((prev) => [turn, ...prev.slice(0, 5)]);
        },
        onMicLevelChange: (lvl) => setMicLevel(lvl),
        onMicWarning: (warn) => setMicWarning(warn),
      },
      catalog
    );
    sessionRef.current = session;

    return () => {
      session.stopRadioConversation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerGesture, moveChassis]);

  useEffect(() => {
    if (catalog.length > 0) {
      sessionRef.current?.setCatalog(catalog);
    }
  }, [catalog]);

  const handleToggleConversation = async () => {
    if (!sessionRef.current) return;
    if (conversationActive) {
      sessionRef.current.stopRadioConversation();
    } else {
      await sessionRef.current.startRadioConversation();
      await sessionRef.current.respondWithMusic(
        '¡Hola Bumblebee! ¿Cómo estás hoy?'
      );
    }
  };

  const handleSendPrompt = async (text: string) => {
    if (!text.trim() || !sessionRef.current) return;
    await sessionRef.current.respondWithMusic(text);
  };

  const esCount = useMemo(() => catalog.filter((c) => c.lang === 'es').length, [catalog]);
  const enCount = useMemo(() => catalog.filter((c) => c.lang === 'en').length, [catalog]);

  const controlsColumn = (
    <div className="flex flex-col gap-4">
      <ApiKeyCollapsible />

      {/* 1. Hero Card: Bumblebee Radio Mode */}
      <div className="rounded-2xl border-2 border-[#F9AB00] bg-white p-5 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="h-3.5 w-3.5 rounded-full bg-[#F9AB00]" />
            <h1 className="text-lg font-bold text-[#202124]">
              Demo D · Modo Bumblebee Radio
            </h1>
          </div>
          <button
            type="button"
            onClick={() => {
              sessionRef.current?.stopCurrentPlayback();
              resetScene();
            }}
            className="shrink-0 rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3 py-1.5 text-xs font-bold text-[#202124] hover:border-[#F9AB00]"
          >
            Posición Inicial
          </button>
        </div>

        <p className="mt-2 text-xs leading-relaxed text-[#5F6368]">
          Su caja de voz está dañada: busca en tiempo real con embeddings semánticos entre{' '}
          <strong>{catalog.length || 171} segmentos de canciones</strong> ({esCount} ES / {enCount} EN),
          encadena frases musicales y baila con los 6 ejes + chasis Mecanum.
        </p>

        <div className="mt-3.5 flex flex-col gap-2.5 sm:flex-row">
          <button
            type="button"
            onClick={handleToggleConversation}
            className={`flex-1 rounded-xl px-5 py-3.5 text-sm font-extrabold shadow-xs transition-all active:scale-98 ${
              conversationActive
                ? 'bg-[#D93025] text-white hover:bg-[#B31412]'
                : 'bg-[#F9AB00] text-[#202124] hover:bg-[#EA8600]'
            }`}
          >
            {conversationActive
              ? '⏹ Detener Conversación Musical'
              : '📻 Iniciar Conversación Musical'}
          </button>

          {nowPlaying && (
            <button
              type="button"
              onClick={() => sessionRef.current?.stopCurrentPlayback()}
              className="rounded-xl border-2 border-[#202124] bg-[#202124] px-4 py-3.5 text-xs font-bold text-white hover:bg-[#3C4043]"
            >
              Cortar
            </button>
          )}
        </div>

        {/* FM Tuner Display */}
        <div className="mt-3.5 rounded-xl border border-[#202124] bg-[#111318] p-4 text-white">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <div className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  radioStatus === 'playing'
                    ? 'animate-ping bg-[#FBBC04]'
                    : conversationActive
                      ? 'bg-[#34A853]'
                      : 'bg-[#5F6368]'
                }`}
              />
              <span className="font-mono text-xs font-bold tracking-wider text-[#FBBC04]">
                {frequencyMhz}
              </span>
              <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-white/80">
                {radioStatus === 'playing'
                  ? 'ON AIR · BAILANDO'
                  : radioStatus === 'tuning'
                    ? 'SINTONIZANDO DIAL...'
                    : conversationActive
                      ? 'MIC ABIERTO (AudioWorklet 16 kHz)'
                      : 'STANDBY'}
              </span>
            </div>

            {conversationActive && (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-white/60">MIC</span>
                <div className="h-2 w-14 overflow-hidden rounded-full bg-white/15">
                  <div
                    className="h-full bg-[#34A853] transition-all duration-75"
                    style={{ width: `${Math.min(100, Math.round(micLevel * 100))}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {nowPlaying ? (
            <div className="mt-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-bold uppercase tracking-wider text-[#FBBC04]">
                  {nowPlaying.title} — {nowPlaying.artist}
                </span>
                <span className="shrink-0 rounded bg-[#FBBC04] px-2 py-0.5 font-mono text-[10px] font-extrabold uppercase text-[#202124]">
                  {nowPlaying.lang === 'es' ? 'ES' : 'EN'} · {nowPlaying.gesture}
                </span>
              </div>
              <p className="mt-1.5 font-display text-base font-extrabold leading-snug text-white">
                “{nowPlaying.lyrics}”
              </p>
            </div>
          ) : (
            <p className="mt-2.5 text-xs leading-relaxed text-white/80">{radioCaption}</p>
          )}

          {userTranscript && (
            <p className="mt-2 border-t border-white/10 pt-2 font-mono text-xs text-[#8AB4F8]">
              Tú: “{userTranscript}”
            </p>
          )}
        </div>

        {micWarning && (
          <p className="mt-3 rounded-xl border border-[#F9AB00] bg-[#FEF7E0] px-3.5 py-2 text-xs font-medium text-[#B06000]">
            {micWarning}
          </p>
        )}

        {/* Text Input with Fast Embedding Search */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!customPrompt.trim()) return;
            handleSendPrompt(customPrompt);
            setCustomPrompt('');
          }}
          className="mt-3.5 flex gap-2"
        >
          <input
            type="text"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="Dile algo a Bumblebee en español o inglés..."
            className="flex-1 rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3.5 py-2.5 text-xs font-medium text-[#202124] focus:border-[#F9AB00] focus:bg-white focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-xl bg-[#202124] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#3C4043]"
          >
            Responder
          </button>
        </form>

        {/* Quick Stage Conversation Prompts */}
        <div className="mt-3.5">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#5F6368]">
            Frases rápidas para probar en vivo:
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => handleSendPrompt(q)}
                className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3 py-1.5 text-left text-xs font-semibold text-[#202124] transition-colors hover:border-[#F9AB00] hover:bg-[#FEF7E0]"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 2. Physical Dance Choreographies */}
      <div className="rounded-2xl border border-[#DADCE0] bg-white p-4 shadow-xs">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[#5F6368]">
          Coreografías Físicas de Baile (6-DOF + Mecanum)
        </h2>
        <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {DANCE_PRESETS.map((d, idx) => (
            <button
              key={d.id}
              type="button"
              onClick={() => {
                triggerGesture(d.id, 'dancing');
                const dir = idx % 2 === 0 ? 1 : -1;
                moveChassis(0.05 * dir, 0.14 * dir, 0.35 * dir, 500);
              }}
              className={`rounded-xl px-3 py-2 text-xs font-extrabold shadow-2xs transition-transform active:scale-95 ${d.color}`}
            >
              🕺 {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* 3. Recent Musical Sentence Log */}
      {turnHistory.length > 0 && (
        <div className="rounded-2xl border border-[#DADCE0] bg-white p-4 shadow-xs">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#5F6368]">
            Secuencias Musicales Sintonizadas
          </h2>
          <div className="mt-2.5 space-y-2">
            {turnHistory.map((t) => (
              <div
                key={t.id}
                className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] p-3 text-xs"
              >
                <div className="flex items-center justify-between text-[11px] text-[#5F6368]">
                  <span className="font-semibold text-[#202124]">Tú: “{t.userText}”</span>
                  <span className="font-mono">{t.timestamp}</span>
                </div>
                <div className="mt-1.5 flex flex-col gap-1">
                  {t.clips.map((c, i) => (
                    <div key={`${t.id}-${c.id}-${i}`} className="flex items-center gap-2">
                      <span className="rounded bg-[#202124] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-[#FBBC04]">
                        #{i + 1} {c.lang}
                      </span>
                      <span className="font-bold text-[#202124]">
                        “{c.lyrics}”
                      </span>
                      <span className="truncate text-[11px] text-[#5F6368]">
                        ({c.title} · {c.artist})
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
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
      <TopNav bridgeConnected={bridgeConnected} liteMode={false} />
      <main className="flex h-[calc(100vh-56px)] w-full overflow-hidden">
        <aside className="flex w-[460px] shrink-0 flex-col overflow-y-auto border-r border-[#DADCE0] bg-[#F8F9FA] p-4">
          {controlsColumn}
        </aside>
        <section className="flex flex-1 flex-col overflow-hidden">
          <Rosorin3DViewer
            telemetry={telemetry}
            sceneMode="sandbox"
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
