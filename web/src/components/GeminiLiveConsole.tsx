'use client';

import React, { useEffect, useState } from 'react';
import { getStoredOrEnvApiKey } from './ApiKeyCollapsible';

interface GeminiLiveConsoleProps {
  status: 'idle' | 'connecting' | 'live' | 'rehearsal_voice';
  speaking?: boolean;
  externalActive?: boolean;
  micLevel?: number;
  micWarning?: string | null;
  userTranscript?: string;
  verdictHeadline: string;
  placeholderHeadline: string;
  quickQuestions?: string[];
  onSendBargeIn: (text: string) => void;
  onStopContinuous?: () => void;
  onInterruptSpeech?: () => void;
}

export function GeminiLiveConsole({
  status,
  speaking = false,
  externalActive = false,
  micLevel = 0,
  micWarning = null,
  userTranscript = '',
  verdictHeadline,
  placeholderHeadline,
  quickQuestions = [],
  onSendBargeIn,
  onStopContinuous,
  onInterruptSpeech,
}: GeminiLiveConsoleProps) {
  const [questionDraft, setQuestionDraft] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [hasKey, setHasKey] = useState(true);

  const refreshKeyStatus = () => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('rosorin_gemini_api_key') || '';
    setApiKeyDraft(saved);
    const effective = getStoredOrEnvApiKey();
    setHasKey(Boolean(effective));
  };

  useEffect(() => {
    refreshKeyStatus();
    window.addEventListener('rosorin-api-key-updated', refreshKeyStatus);
    window.addEventListener('storage', refreshKeyStatus);
    return () => {
      window.removeEventListener('rosorin-api-key-updated', refreshKeyStatus);
      window.removeEventListener('storage', refreshKeyStatus);
    };
  }, []);

  const handleSaveKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof window !== 'undefined') {
      if (apiKeyDraft.trim()) {
        window.localStorage.setItem('rosorin_gemini_api_key', apiKeyDraft.trim());
      } else {
        window.localStorage.removeItem('rosorin_gemini_api_key');
      }
      refreshKeyStatus();
      window.dispatchEvent(new Event('rosorin-api-key-updated'));
      setShowKeyInput(false);
    }
  };

  const handleSubmitQuestion = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = questionDraft.trim();
    if (!trimmed) return;
    setQuestionDraft('');
    onSendBargeIn(trimmed);
  };

  const isActive = externalActive || speaking;

  return (
    <div className="rounded-2xl border border-[#DADCE0] bg-white p-6 text-[#202124] shadow-xs">
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#1A73E8]" />
          <span className="text-base font-bold text-[#202124]">Gemini Live</span>
          <span
            className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
              speaking
                ? 'bg-[#E8F0FE] text-[#1A73E8]'
                : externalActive
                  ? 'bg-[#E6F4EA] text-[#1E8E3E]'
                  : status === 'live'
                    ? 'bg-[#E6F4EA] text-[#1E8E3E]'
                    : 'bg-[#F1F3F4] text-[#5F6368]'
            }`}
          >
            {speaking
              ? 'Hablando...'
              : externalActive
                ? 'Escuchando tu micrófono'
                : 'Listo'}
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Audio Equalizer */}
          <div className="flex h-5 items-end gap-1" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5, 6].map((idx) => {
              const baseHeights = [8, 16, 12, 18, 10, 15, 9];
              const dynamicMicHeight = Math.max(
                4,
                Math.round(baseHeights[idx] * Math.max(0.25, micLevel))
              );
              return (
                <span
                  key={idx}
                  className={`w-1.5 rounded-full transition-all duration-100 ${
                    speaking || externalActive
                      ? `bg-[#1A73E8] ${speaking ? 'animate-pulse' : ''}`
                      : 'bg-[#DADCE0]'
                  }`}
                  style={{
                    height: speaking
                      ? `${baseHeights[idx]}px`
                      : externalActive
                        ? `${dynamicMicHeight}px`
                        : '4px',
                  }}
                />
              );
            })}
          </div>

          {speaking && (
            <button
              type="button"
              onClick={() => onInterruptSpeech?.()}
              className="rounded-xl bg-[#F9AB00] px-3 py-1.5 text-xs font-bold text-[#202124] transition-colors hover:bg-[#F29900]"
            >
              Interrumpir
            </button>
          )}

          {isActive && (
            <button
              type="button"
              onClick={() => onStopContinuous?.()}
              className="rounded-xl bg-[#D93025] px-3.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-[#B3261E]"
            >
              Detener
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowKeyInput((v) => !v)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${
              hasKey
                ? 'border-[#DADCE0] bg-[#F8F9FA] text-[#5F6368] hover:border-[#1A73E8] hover:text-[#1A73E8]'
                : 'border-[#F9AB00] bg-[#FEF7E0] text-[#B06000]'
            }`}
          >
            {hasKey ? 'API Key ✓' : 'Ingresar API Key'}
          </button>
        </div>
      </div>

      {(!hasKey || showKeyInput) && (
        <form
          onSubmit={handleSaveKey}
          className="mt-3 flex flex-col gap-2 rounded-xl border border-[#F9AB00] bg-[#FEF7E0]/60 p-3"
        >
          <p className="text-xs font-medium text-[#B06000]">
            {hasKey
              ? 'Actualiza tu GEMINI_API_KEY en el navegador (se guarda solo en localStorage):'
              : 'No se pudo cargar GEMINI_API_KEY desde .env. Ingresa tu API Key aquí para guardarla en tu navegador:'}
          </p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              placeholder="AIzaSy... (GEMINI_API_KEY)"
              className="flex-1 rounded-lg border border-[#DADCE0] bg-white px-3 py-1.5 font-mono text-xs text-[#202124] focus:border-[#1A73E8] focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-lg bg-[#1A73E8] px-3.5 py-1.5 text-xs font-bold text-white"
            >
              Guardar
            </button>
          </div>
        </form>
      )}

      {micWarning && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#F9AB00] bg-[#FEF7E0] px-3.5 py-2.5 text-xs font-semibold text-[#B06000]">
          <span>{micWarning}</span>
        </div>
      )}

      {/* Spoken Output */}
      <div className="mt-4 rounded-xl border border-[#DADCE0] bg-[#F8F9FA] p-4">
        <p className="text-base font-semibold leading-relaxed text-[#202124]">
          “{verdictHeadline || placeholderHeadline}”
        </p>
        {userTranscript && (
          <p className="mt-2 text-xs font-medium text-[#5F6368]">
            Tú: <span className="font-bold text-[#1A73E8]">“{userTranscript}”</span>
          </p>
        )}
      </div>

      {/* Follow-up Question Input & Quick Questions */}
      <form onSubmit={handleSubmitQuestion} className="mt-4 flex flex-col gap-2.5">
        <input
          type="text"
          value={questionDraft}
          onChange={(e) => setQuestionDraft(e.target.value)}
          placeholder="Háblale por micrófono o escribe aquí para pedir más detalles..."
          className="w-full rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-4 py-3 text-sm font-medium text-[#202124] focus:border-[#1A73E8] focus:bg-white focus:outline-none"
        />
        <button
          type="submit"
          disabled={!questionDraft.trim()}
          className="w-full rounded-xl bg-[#202124] px-5 py-3 text-sm font-bold text-white transition-colors hover:bg-[#3C4043] disabled:opacity-40"
        >
          Preguntar
        </button>
      </form>

      {quickQuestions.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {quickQuestions.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onSendBargeIn(q)}
              className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] px-3.5 py-2.5 text-left text-xs font-semibold text-[#202124] transition-colors hover:border-[#1A73E8] hover:bg-[#E8F0FE] hover:text-[#1A73E8]"
            >
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
