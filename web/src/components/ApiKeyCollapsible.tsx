'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  API_KEY_UPDATED_EVENT,
  getApiKeySource,
  getStoredApiKey,
  saveApiKey,
  type ApiKeySource,
} from '@/lib/api-key';

export function ApiKeyCollapsible() {
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [sourceLabel, setSourceLabel] = useState<ApiKeySource>('none');
  const [savedNotice, setSavedNotice] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const syncKeyState = () => {
      const source = getApiKeySource();
      setSourceLabel(source);
      setHasKey(source !== 'none');
      setKeyInput(source === 'browser' || source === 'launcher' ? getStoredApiKey() : '');
    };
    syncKeyState();
    window.addEventListener('storage', syncKeyState);
    window.addEventListener(API_KEY_UPDATED_EVENT, syncKeyState);
    return () => {
      window.removeEventListener('storage', syncKeyState);
      window.removeEventListener(API_KEY_UPDATED_EVENT, syncKeyState);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveApiKey(keyInput);
    setSavedNotice(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => {
      setSavedNotice(false);
      setOpen(false);
    }, 900);
  };

  const handleClear = () => {
    saveApiKey('');
    setKeyInput('');
  };

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
            {sourceLabel === 'launcher'
              ? 'Cargada desde GEMINI_API_KEY (.env)'
              : sourceLabel === 'browser'
                ? 'Cargada en navegador (localStorage)'
                : sourceLabel === 'env'
                  ? 'Cargada desde NEXT_PUBLIC_GEMINI_API_KEY (desaconsejado)'
                  : 'No configurada — clic para ingresar en navegador'}
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
          <p className="text-xs text-[#5F6368]">
            Define <code className="font-mono text-[#202124]">GEMINI_API_KEY</code> en{' '}
            <code className="font-mono text-[#202124]">web/.env</code> y <code className="font-mono text-[#202124]">run.sh</code> la
            trae sola en el fragmento de la URL, o pégala aquí. Se guarda únicamente en el{' '}
            <code className="font-mono text-[#202124]">localStorage</code> de tu navegador (nunca se sube al repositorio ni al servidor).
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
              placeholder="Pega tu GEMINI_API_KEY (AIzaSy...)"
              className="min-w-[240px] flex-1 rounded-xl border border-[#DADCE0] bg-white px-3.5 py-2 font-mono text-xs text-[#202124] focus:border-[#1A73E8] focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-xl bg-[#1A73E8] px-4 py-2 text-xs font-bold text-white hover:bg-[#1557B0]"
            >
              {savedNotice ? '✓ Guardada' : 'Guardar en navegador'}
            </button>
            {(sourceLabel === 'browser' || sourceLabel === 'launcher') && (
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
