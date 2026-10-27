'use client';

import React, { useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { RobotBridgeClient, describeBridgeError } from '@/lib/robot-client';
import { isBridgeEnabled } from '@/lib/bridge-config';

/**
 * Route-level error boundary: instead of Next's blank "Application error", keep
 * the navigation and an emergency stop that talks to the bridge directly (the
 * page's telemetry hook is gone at this point).
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [bridgeEnabled, setBridgeEnabled] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);

  useEffect(() => {
    console.error('[app] Error en la página:', error);
    setBridgeEnabled(isBridgeEnabled());
  }, [error]);

  const handleStop = async () => {
    try {
      await new RobotBridgeClient().emergencyStop();
      setStopNotice('STOP enviado al robot.');
    } catch (err) {
      setStopNotice(describeBridgeError(err).message);
    }
  };

  return (
    <div className="flex min-h-screen w-screen flex-col bg-[#F8F9FA] text-[#202124]">
      <TopNav />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
        <div role="alert" className="rounded-2xl border border-[#DADCE0] bg-white p-5 shadow-xs">
          <h1 className="text-lg font-bold text-[#202124]">Esta página tuvo un error</h1>
          <p className="mt-1 text-sm text-[#5F6368]">
            {error.message || 'Error desconocido.'} Puedes reintentar o volver al Hub; el robot no recibe órdenes nuevas
            desde esta pantalla.
          </p>
          <div className="mt-3.5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-xl bg-[#1A73E8] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#1557B0]"
            >
              Reintentar
            </button>
            {bridgeEnabled && (
              <button
                type="button"
                onClick={() => void handleStop()}
                className="rounded-xl bg-[#D93025] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#B3261E]"
              >
                STOP
              </button>
            )}
          </div>
          {stopNotice && (
            <p className="mt-2 text-xs font-semibold text-[#5F6368]" role="status">
              {stopNotice}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
