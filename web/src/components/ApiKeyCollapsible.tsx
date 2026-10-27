'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  API_KEY_UPDATED_EVENT,
  getApiKeySource,
  getBridgeKeyStatus,
  getManualApiKey,
  setManualApiKey,
  type ApiKeySource,
  type BridgeKeyStatus,
} from '@/lib/api-key';

export const MISSING_KEY_NOTICE =
  'Falta la API key de Gemini: agrégala a web/.env del robot (GEMINI_API_KEY) o ingrésala aquí.';
export const MEMORY_ONLY_NOTICE = 'Solo se usa mientras esta página está abierta; no se guarda.';

function sourceText(source: ApiKeySource, bridge: BridgeKeyStatus): string {
  if (source === 'manual') return 'Ingresada a mano (solo esta página)';
  if (source === 'bridge') return 'Cargada desde GEMINI_API_KEY (web/.env del robot)';
  if (bridge === 'loading' || bridge === 'idle') return 'Buscando la key en el bridge…';
  return 'Falta la API key — clic para ingresarla';
}

export function ApiKeyCollapsible() {
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [sourceLabel, setSourceLabel] = useState<ApiKeySource>('none');
  const [bridgeStatus, setBridgeStatus] = useState<BridgeKeyStatus>('idle');
  const [savedNotice, setSavedNotice] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const syncKeyState = () => {
      const source = getApiKeySource();
      setSourceLabel(source);
      setBridgeStatus(getBridgeKeyStatus());
      setHasKey(source !== 'none');
      setKeyInput(getManualApiKey());
    };
    syncKeyState();
    window.addEventListener(API_KEY_UPDATED_EVENT, syncKeyState);
    return () => {
      window.removeEventListener(API_KEY_UPDATED_EVENT, syncKeyState);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setManualApiKey(keyInput);
    setSavedNotice(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => {
      setSavedNotice(false);
      setOpen(false);
    }, 900);
  };

  const handleClear = () => {
    setManualApiKey('');
    setKeyInput('');
  };

  const missing = !hasKey && bridgeStatus !== 'loading' && bridgeStatus !== 'idle';

  return (
    <div className="rounded-2xl border border-[#DADCE0] bg-white shadow-2xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2.5">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              hasKey ? 'bg-[#1E8E3E]' : 'bg-[#F9AB00]'
            }`}
          />
          <span className="text-xs font-bold text-[#202124]">
            Gemini Live API Key
          </span>
          <span
            className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-bold ${
              hasKey
                ? 'bg-[#E6F4EA] text-[#1E8E3E]'
                : 'bg-[#FEF7E0] text-[#B06000]'
            }`}
          >
            {sourceText(sourceLabel, bridgeStatus)}
          </span>
        </div>
        <span className="font-mono text-xs font-bold text-[#5F6368]">
          {open ? 'Ocultar ▲' : 'Configurar ▼'}
        </span>
      </button>

      {open && (
        <form
          onSubmit={handleSave}
          className="border-t border-[#DADCE0] bg-[#F8F9FA] px-4 py-3.5"
        >
          {missing && (
            <p role="alert" className="mb-2 text-xs font-semibold text-[#B06000]">
              {MISSING_KEY_NOTICE}
            </p>
          )}
          <p className="text-xs text-[#5F6368]">
            La web le pide la key al bridge del robot (<code className="font-mono text-[#202124]">GEMINI_API_KEY</code> en{' '}
            <code className="font-mono text-[#202124]">web/.env</code>). Si la pegas aquí, gana sobre la del bridge.{' '}
            {MEMORY_ONLY_NOTICE}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <label htmlFor="api-key-collapsible-input" className="sr-only">
              GEMINI_API_KEY
            </label>
            <input
              id="api-key-collapsible-input"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Pega tu GEMINI_API_KEY"
              className="min-w-[240px] flex-1 rounded-xl border border-[#DADCE0] bg-white px-3.5 py-2 font-mono text-xs text-[#202124] focus:border-[#1A73E8] focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-xl bg-[#1A73E8] px-4 py-2 text-xs font-bold text-white hover:bg-[#1557B0]"
            >
              {savedNotice ? '✓ Lista' : 'Usar en esta página'}
            </button>
            {sourceLabel === 'manual' && (
              <button
                type="button"
                onClick={handleClear}
                className="rounded-xl border border-[#DADCE0] bg-white px-3 py-2 text-xs font-bold text-[#5F6368] hover:text-[#D93025]"
              >
                Borrar
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
