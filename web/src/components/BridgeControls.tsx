'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  bridgeHost,
  getBridgeToken,
  getStoredBridgeUrl,
  isBridgeEnabled,
  isPublicSite,
  onBridgeConfigChange,
  resolveBridgeUrl,
  setBridgeEnabled,
  setBridgeToken,
  setStoredBridgeUrl,
} from '@/lib/bridge-config';
import type { BridgeUiState, RobotActionResult } from '@/lib/types';

interface BridgeAlertsProps {
  bridge?: BridgeUiState;
  onReleaseEstop?: () => Promise<RobotActionResult>;
  onOpenSettings?: () => void;
}

/** Floating safety banners: latched E-stop, stale LiDAR and token errors. */
export function BridgeAlerts({ bridge, onReleaseEstop, onOpenSettings }: BridgeAlertsProps) {
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  if (!bridge || (!bridge.estopLatched && !bridge.lidarStale && !bridge.authError)) return null;

  const handleRelease = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onReleaseEstop) return;
    setReleasing(true);
    setReleaseError(null);
    const result = await onReleaseEstop();
    setReleasing(false);
    if (!result.ok) setReleaseError(result.message);
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-16 z-50 flex flex-col items-center gap-2 px-4"
      role="region"
      aria-label="Avisos de seguridad del robot"
    >
      {bridge.estopLatched && (
        <div
          role="alert"
          className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-xl border-2 border-[#D93025] bg-[#FCE8E6] px-4 py-2.5 text-sm font-bold text-[#A50E0E] shadow-md"
        >
          <span>STOP activo</span>
          {onReleaseEstop && (
            <button
              type="button"
              onClick={handleRelease}
              disabled={releasing}
              className="rounded-lg bg-[#D93025] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#B3261E] disabled:opacity-50"
            >
              {releasing ? 'Liberando…' : 'Liberar'}
            </button>
          )}
          {releaseError && <span className="text-xs font-semibold">{releaseError}</span>}
        </div>
      )}
      {bridge.connected && bridge.workerDown && (
        <div
          role="alert"
          className="pointer-events-auto rounded-xl border-2 border-[#D93025] bg-[#FCE8E6] px-4 py-2.5 text-sm font-bold text-[#A50E0E] shadow-md"
        >
          El control del robot no responde: chasis bloqueado
        </div>
      )}
      {bridge.lidarStale && (
        <div
          role="alert"
          className="pointer-events-auto rounded-xl border-2 border-[#F9AB00] bg-[#FEF7E0] px-4 py-2.5 text-sm font-bold text-[#8A4B00] shadow-md"
        >
          LiDAR sin datos: chasis bloqueado
        </div>
      )}
      {bridge.authError && (
        <div
          role="alert"
          className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-xl border-2 border-[#F9AB00] bg-[#FEF7E0] px-4 py-2.5 text-sm font-bold text-[#8A4B00] shadow-md"
        >
          <span>El bridge pide token</span>
          {onOpenSettings && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSettings();
              }}
              className="rounded-lg bg-[#202124] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#3C4043]"
            >
              Configurar token
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface BridgeSettingsPanelProps {
  bridge?: BridgeUiState;
  onEmergencyStop?: () => Promise<RobotActionResult>;
  onClose: () => void;
}

/** Bridge URL, shared token and on/off switch (stored only in this browser). */
export function BridgeSettingsPanel({ bridge, onEmergencyStop, onClose }: BridgeSettingsPanelProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [publicSite, setPublicSite] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      setEnabled(isBridgeEnabled());
      setPublicSite(isPublicSite());
      setCurrentUrl(resolveBridgeUrl());
      setUrlDraft(getStoredBridgeUrl());
      setHasToken(Boolean(getBridgeToken()));
    };
    sync();
    return onBridgeConfigChange(sync);
  }, []);

  // Initial focus inside the dialog; focus goes back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Handled here so the global E-stop shortcut (Escape) does not also fire.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const statusText = !enabled
    ? 'Desconectado: solo simulador 3D'
    : bridge?.authError
      ? 'El bridge pide token'
      : bridge?.connected
        ? `Conectado · ${
            bridge.lidarSource === 'none' && !bridge.lidarStale
              ? 'Sin LiDAR (serial)'
              : `LiDAR: ${bridge.lidarSource ?? 'n/d'}`
          }`
        : 'Buscando el bridge (reintento con espera creciente)…';

  const saveUrl = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const tokenCleared = setStoredBridgeUrl(urlDraft.trim() || null);
      setNotice(
        `${urlDraft.trim() ? 'URL guardada.' : 'URL restablecida.'}${
          tokenCleared ? ' Cambiaste de host: se borró el token (pega el del nuevo bridge).' : ''
        }`
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const saveToken = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenDraft.trim()) return;
    setBridgeToken(tokenDraft);
    setTokenDraft('');
    setNotice('Token guardado en este navegador.');
  };

  const handleStop = async () => {
    if (!onEmergencyStop) return;
    const result = await onEmergencyStop();
    setNotice(result.ok ? 'STOP enviado.' : result.message);
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Conexión con el robot"
      onKeyDown={handleKeyDown}
      className="absolute right-0 top-12 z-50 w-[340px] rounded-2xl border border-[#DADCE0] bg-white p-4 text-left text-[#202124] shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold">Conexión con el robot</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-xs font-bold text-[#5F6368] hover:bg-[#F1F3F4]"
        >
          Cerrar
        </button>
      </div>

      <p className="mt-1 text-xs text-[#5F6368]" role="status" aria-live="polite">
        {statusText}
      </p>
      <p className="mt-1 truncate text-[11px] text-[#5F6368]">
        Host del bridge: <span className="font-mono font-bold text-[#202124]">{bridgeHost(currentUrl) || currentUrl}</span>
        {hasToken ? ' · el token solo se envía a este host' : ''}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setBridgeEnabled(!enabled)}
          className={`rounded-xl px-3.5 py-2 text-xs font-bold ${
            enabled
              ? 'border border-[#DADCE0] bg-[#F8F9FA] text-[#202124] hover:border-[#1A73E8]'
              : 'bg-[#1A73E8] text-white hover:bg-[#1557B0]'
          }`}
        >
          {enabled ? 'Desconectar del robot' : 'Conectar al robot'}
        </button>
        {bridge?.connected && onEmergencyStop && (
          <button
            type="button"
            onClick={handleStop}
            className="rounded-xl bg-[#D93025] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#B3261E]"
          >
            STOP
          </button>
        )}
      </div>

      <form onSubmit={saveUrl} className="mt-3 flex flex-col gap-1.5">
        <label htmlFor="bridge-url-input" className="text-xs font-bold">
          URL del bridge (localhost o LAN)
        </label>
        <div className="flex gap-2">
          <input
            id="bridge-url-input"
            type="url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="http://192.168.1.50:9000"
            className="flex-1 rounded-lg border border-[#DADCE0] bg-white px-2.5 py-1.5 font-mono text-xs focus:border-[#1A73E8] focus:outline-none"
          />
          <button type="submit" className="rounded-lg bg-[#202124] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#3C4043]">
            Guardar
          </button>
        </div>
      </form>

      <form onSubmit={saveToken} className="mt-3 flex flex-col gap-1.5">
        <label htmlFor="bridge-token-input" className="text-xs font-bold">
          Token del bridge {hasToken ? '(guardado)' : '(sin token)'}
        </label>
        <div className="flex gap-2">
          <input
            id="bridge-token-input"
            type="password"
            autoComplete="off"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder={hasToken ? '•••••• (pega uno nuevo para cambiarlo)' : 'BRIDGE_TOKEN'}
            className="flex-1 rounded-lg border border-[#DADCE0] bg-white px-2.5 py-1.5 font-mono text-xs focus:border-[#1A73E8] focus:outline-none"
          />
          <button type="submit" className="rounded-lg bg-[#202124] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#3C4043]">
            Guardar
          </button>
          {hasToken && (
            <button
              type="button"
              onClick={() => {
                setBridgeToken(null);
                setNotice('Token borrado.');
              }}
              className="rounded-lg border border-[#DADCE0] px-3 py-1.5 text-xs font-bold text-[#5F6368] hover:text-[#D93025]"
            >
              Borrar
            </button>
          )}
        </div>
        <p className="text-[11px] text-[#5F6368]">
          También puedes abrir cualquier página con <code className="font-mono">#token=…</code> (se guarda y se quita de la
          barra; <code className="font-mono">?token=…</code> también funciona) o{' '}
          <code className="font-mono">#token=reset</code> para borrarlo. Si cambias a otro host, el token se borra.
        </p>
      </form>

      {publicSite && (
        <p className="mt-3 rounded-lg bg-[#FEF7E0] px-2.5 py-2 text-[11px] text-[#8A4B00]">
          Estás en el sitio público: no se contacta al robot hasta que pulses «Conectar». La demo con el robot físico se
          usa desde <code className="font-mono">http://localhost:3000</code>.
        </p>
      )}
      {notice && (
        <p className="mt-2 text-xs font-semibold text-[#1E8E3E]" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
