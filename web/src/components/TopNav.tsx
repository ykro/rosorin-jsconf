'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { stopAllActiveConversations, type StopReason } from '@/lib/gemini-live';
import { stopActiveBumblebeeSession } from '@/lib/bumblebee-radio';
import type { RobotLink } from '@/lib/use-robot-telemetry';
import { BridgeAlerts, BridgeSettingsPanel } from './BridgeControls';

function stopAllSessions(reason: StopReason) {
  stopAllActiveConversations(reason);
  stopActiveBumblebeeSession(reason);
}

interface TopNavProps {
  /** Robot link from useRobotTelemetry(); omit on pages without telemetry. */
  robot?: Pick<RobotLink, 'bridge' | 'releaseEstop' | 'emergencyStop'>;
  liteMode?: boolean;
  subtitle?: string;
}

export function TopNav({ robot, liteMode: propLite }: TopNavProps) {
  const pathname = usePathname();
  const [isLite, setIsLite] = useState(
    propLite ?? process.env.NEXT_PUBLIC_LITE_MODE === '1'
  );
  const [panelOpen, setPanelOpen] = useState(false);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const bridge = robot?.bridge;

  // Switching tabs stops the conversation on purpose: otherwise the robot keeps
  // listening (and answering) while the presenter talks over the slides. The
  // session shows a notice explaining why it stopped.
  useEffect(() => {
    stopAllSessions('navigation');
    const handleVisibility = () => {
      if (document.hidden) stopAllSessions('tab_hidden');
    };
    const handlePageHide = () => stopAllSessions('navigation');
    window.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [pathname]);

  useEffect(() => {
    if (propLite !== undefined) {
      setIsLite(propLite);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get('lite') === '1' || pathname === '/robot' || process.env.NEXT_PUBLIC_LITE_MODE === '1') {
      setIsLite(true);
    } else {
      try {
        window.localStorage.removeItem('ROSORIN_LITE_MODE');
      } catch (err) {
        console.warn('[nav] localStorage no disponible:', err);
      }
      setIsLite(false);
    }
  }, [pathname, propLite]);

  const links = isLite
    ? [
        { href: '/', match: '/', label: 'Hub' },
        { href: '/slides/index.html', match: '/slides', label: 'Slides' },
        { href: '/robot', match: '/robot', label: 'Consola' },
        { href: '/demos/roaster?lite=1', match: '/demos/roaster', label: 'Demo A' },
        { href: '/demos/gatekeeper?lite=1', match: '/demos/gatekeeper', label: 'Demo B' },
        { href: '/demos/bughunter?lite=1', match: '/demos/bughunter', label: 'Demo C' },
        { href: '/demos/bumblebee?lite=1', match: '/demos/bumblebee', label: 'Demo D' },
      ]
    : [
        { href: '/', match: '/', label: 'Hub' },
        { href: '/slides/index.html', match: '/slides', label: 'Slides' },
        { href: '/demo', match: '/demo', label: 'Simulador (/demo)' },
        { href: '/demos/roaster', match: '/demos/roaster', label: 'Demo A' },
        { href: '/demos/gatekeeper', match: '/demos/gatekeeper', label: 'Demo B' },
        { href: '/demos/bughunter', match: '/demos/bughunter', label: 'Demo C' },
        { href: '/demos/bumblebee', match: '/demos/bumblebee', label: 'Demo D · Bumblebee' },
      ];

  const pillLabel = !bridge
    ? 'Robot'
    : bridge.authError
      ? 'El bridge pide token'
      : bridge.connected
        ? bridge.estopLatched
          ? 'Robot en paro'
          : 'Robot conectado'
        : bridge.enabled
          ? 'Robot sin conexión'
          : 'Simulador 3D';

  const pillTone = bridge?.connected && !bridge.estopLatched
    ? 'border-[#34A853] bg-[#E6F4EA] text-[#1E8E3E]'
    : bridge?.authError || bridge?.estopLatched
      ? 'border-[#D93025] bg-[#FCE8E6] text-[#A50E0E]'
      : 'border-[#DADCE0] bg-[#FEF7E0] text-[#B06000]';

  const dotTone = bridge?.connected && !bridge.estopLatched
    ? 'bg-[#1E8E3E]'
    : bridge?.authError || bridge?.estopLatched
      ? 'bg-[#D93025]'
      : 'bg-[#F9AB00]';

  return (
    <>
      <header className="sticky top-0 z-40 h-14 shrink-0 border-b border-[#DADCE0] bg-white px-4">
        <div className="flex h-full w-full items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-4">
            <Link
              href={isLite ? '/robot' : '/'}
              prefetch={true}
              className="shrink-0 font-display text-base font-extrabold tracking-tight text-[#202124]"
            >
              ROSOrin Pro
            </Link>

            <div className="h-4 w-px shrink-0 bg-[#DADCE0]" />

            <nav className="flex flex-wrap items-center gap-1.5" aria-label="Secciones">
              {links.map((item) => {
                const targetPath = item.match || item.href;
                const active =
                  targetPath === '/'
                    ? pathname === '/' || pathname === '/simulator'
                    : pathname === targetPath || pathname?.startsWith(`${targetPath}/`);
                const className = `shrink-0 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors sm:text-sm ${
                  active ? 'bg-[#1A73E8] text-white' : 'text-[#5F6368] hover:bg-[#F1F3F4] hover:text-[#202124]'
                }`;
                if (item.href.startsWith('/slides/')) {
                  // Static HTML deck outside the Next router: a plain link (no RSC prefetch).
                  return (
                    <a key={item.href} href={item.href} className={className}>
                      {item.label}
                    </a>
                  );
                }
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={true}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => stopAllSessions('navigation')}
                    className={className}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="relative flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              aria-expanded={panelOpen}
              aria-haspopup="dialog"
              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-bold ${pillTone}`}
            >
              <span className={`h-2 w-2 rounded-full ${dotTone}`} aria-hidden="true" />
              <span>{pillLabel}</span>
            </button>
            {panelOpen && (
              <BridgeSettingsPanel
                bridge={bridge}
                onEmergencyStop={robot?.emergencyStop}
                onClose={closePanel}
              />
            )}
          </div>
        </div>
      </header>
      <BridgeAlerts
        bridge={bridge}
        onReleaseEstop={robot?.releaseEstop}
        onOpenSettings={() => setPanelOpen(true)}
      />
    </>
  );
}
