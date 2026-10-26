'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { stopAllActiveConversations } from '@/lib/gemini-live';
import { stopActiveBumblebeeSession } from '@/lib/bumblebee-radio';

function stopAllSessions() {
  stopAllActiveConversations();
  stopActiveBumblebeeSession();
}

interface TopNavProps {
  bridgeConnected?: boolean;
  liteMode?: boolean;
  subtitle?: string;
}

export function TopNav({ bridgeConnected = false, liteMode: propLite }: TopNavProps) {
  const pathname = usePathname();
  const [isLite, setIsLite] = useState(
    propLite ?? process.env.NEXT_PUBLIC_LITE_MODE === '1'
  );

  useEffect(() => {
    stopAllSessions();
    const handleVisibility = () => {
      if (document.hidden) {
        stopAllSessions();
      }
    };
    window.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', stopAllSessions);
    return () => {
      window.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', stopAllSessions);
    };
  }, [pathname]);

  useEffect(() => {
    if (propLite !== undefined) {
      setIsLite(propLite);
      return;
    }
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('lite') === '1' || pathname === '/robot' || process.env.NEXT_PUBLIC_LITE_MODE === '1') {
        setIsLite(true);
      } else {
        window.localStorage.removeItem('ROSORIN_LITE_MODE');
        setIsLite(false);
      }
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

  return (
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

          <nav className="flex flex-wrap items-center gap-1.5">
            {links.map((item) => {
              const targetPath = item.match || item.href;
              const active =
                targetPath === '/'
                  ? pathname === '/' || pathname === '/simulator'
                  : pathname === targetPath || pathname?.startsWith(`${targetPath}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={true}
                  onClick={() => stopAllSessions()}
                  className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors sm:text-sm ${
                    active
                      ? 'bg-[#1A73E8] text-white'
                      : 'text-[#5F6368] hover:bg-[#F1F3F4] hover:text-[#202124]'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div
            className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-bold ${
              bridgeConnected
                ? 'border-[#34A853] bg-[#E6F4EA] text-[#1E8E3E]'
                : 'border-[#DADCE0] bg-[#FEF7E0] text-[#B06000]'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                bridgeConnected ? 'bg-[#1E8E3E]' : 'bg-[#F9AB00]'
              }`}
            />
            <span>{bridgeConnected ? 'Robot Conectado' : 'Simulador 3D'}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
