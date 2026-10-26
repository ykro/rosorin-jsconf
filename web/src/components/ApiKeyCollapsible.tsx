'use client';

import React, { useEffect, useState } from 'react';

export function getStoredOrEnvApiKey(): string {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem('rosorin_gemini_api_key');
    if (stored && stored.trim()) return stored.trim();
  }
  if (process.env.NEXT_PUBLIC_GEMINI_API_KEY) {
    return process.env.NEXT_PUBLIC_GEMINI_API_KEY.trim();
  }
  return '';
}

export function ApiKeyCollapsible() {
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [sourceLabel, setSourceLabel] = useState<'none' | 'env' | 'browser'>('none');
  const [savedNotice, setSavedNotice] = useState(false);

  const syncKeyState = () => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('rosorin_gemini_api_key')?.trim() || '';
    const envKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY?.trim() || '';
    if (stored) {
      setHasKey(true);
      setSourceLabel('browser');
      setKeyInput(stored);
    } else if (envKey) {
      setHasKey(true);
      setSourceLabel('env');
      setKeyInput('');
    } else {
      setHasKey(false);
      setSourceLabel('none');
      setKeyInput('');
    }
  };

  useEffect(() => {
    syncKeyState();
    const onStorage = () => syncKeyState();
    window.addEventListener('storage', onStorage);
    window.addEventListener('rosorin-api-key-updated', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('rosorin-api-key-updated', onStorage);
    };
  }, []);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof window === 'undefined') return;
    const trimmed = keyInput.trim();
    if (trimmed) {
      window.localStorage.setItem('rosorin_gemini_api_key', trimmed);
    } else {
      window.localStorage.removeItem('rosorin_gemini_api_key');
    }
    syncKeyState();
    window.dispatchEvent(new Event('rosorin-api-key-updated'));
    setSavedNotice(true);
    setTimeout(() => {
      setSavedNotice(false);
      setOpen(false);
    }, 900);
  };

  const handleClear = () => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem('rosorin_gemini_api_key');
    setKeyInput('');
    syncKeyState();
    window.dispatchEvent(new Event('rosorin-api-key-updated'));
  };

  return (
    <div className="rounded-2xl border border-[#DADCE0] bg-white shadow-2xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
            {sourceLabel === 'browser'
              ? 'Cargada en navegador (localStorage)'
              : sourceLabel === 'env'
                ? 'Cargada desde .env'
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
            Se lee de <code className="font-mono text-[#202124]">.env.local</code> en desarrollo o se guarda únicamente en el{' '}
            <code className="font-mono text-[#202124]">localStorage</code> de tu navegador (nunca se sube al repositorio ni al servidor).
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <input
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
            {sourceLabel === 'browser' && (
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
