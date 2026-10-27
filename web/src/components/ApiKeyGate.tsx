'use client';

import React, { useState } from 'react';
import { setManualApiKey } from '@/lib/api-key';
import { missingKeyNotice } from '@/lib/api-key-gate';
import { useApiKeyGate } from '@/lib/use-api-key';

/** The only thing a demo shows while it has no Gemini key: why, plus an input to type one. */
export function ApiKeyPrompt() {
  const gate = useApiKeyGate();
  const [draft, setDraft] = useState('');

  if (gate.state === 'ready') return null;
  if (gate.state === 'loading') {
    return (
      <div className="rounded-2xl border border-[#DADCE0] bg-white px-5 py-4 text-sm font-medium text-[#5F6368] shadow-xs">
        {missingKeyNotice(gate.bridgeStatus)}
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) setManualApiKey(draft);
      }}
      className="flex flex-col gap-3 rounded-2xl border border-[#F9AB00] bg-[#FEF7E0]/60 p-5 shadow-xs"
    >
      <p role="alert" className="text-sm font-semibold text-[#B06000]">
        {missingKeyNotice(gate.bridgeStatus)}
      </p>
      <div className="flex items-center gap-2">
        <label htmlFor="api-key-gate-input" className="sr-only">
          GEMINI_API_KEY
        </label>
        <input
          id="api-key-gate-input"
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="GEMINI_API_KEY"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-xl border border-[#DADCE0] bg-white px-3.5 py-2.5 font-mono text-sm text-[#202124] focus:border-[#1A73E8] focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-xl bg-[#1A73E8] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#1557B0] disabled:opacity-50"
        >
          Usar
        </button>
      </div>
    </form>
  );
}

/**
 * Renders `children` only once the page has a Gemini key. Without one it shows the prompt, or
 * nothing at all with `quiet` (for a second gated block on the same page).
 */
export function ApiKeyGate({ children, quiet = false }: { children: React.ReactNode; quiet?: boolean }) {
  const gate = useApiKeyGate();
  if (gate.state === 'ready') return <>{children}</>;
  return quiet ? null : <ApiKeyPrompt />;
}
