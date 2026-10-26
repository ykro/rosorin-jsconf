'use client';

import React from 'react';
import Link from 'next/link';
import { TopNav } from '@/components/TopNav';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';

export default function LandingHubPage() {
  const robot = useRobotTelemetry();

  return (
    <div className="flex min-h-screen w-screen flex-col bg-[#F8F9FA] text-[#202124]">
      <TopNav robot={robot} liteMode={false} />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-6 px-6 py-10">
        <div>
          <span className="inline-block rounded-lg bg-[#FEF7E0] px-3 py-1 font-mono text-xs font-bold uppercase tracking-wider text-[#B06000]">
            JSConfMX
          </span>
          <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-[#202124] sm:text-4xl">
            De Web a Physical AI
          </h1>
          <p className="mt-1.5 text-sm text-[#5F6368]">
            Acceso directo a la presentación interactiva, al simulador 3D en el navegador y al código fuente.
          </p>
        </div>

        {/* 3 Direct Links: Slides, Demo, Repo */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <a
            href="/slides/index.html"
            style={{ backgroundColor: '#111215', color: '#FFFFFF', borderColor: '#111215' }}
            className="group flex flex-col justify-between rounded-2xl border-2 p-6 shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <div>
              <span
                style={{ backgroundColor: '#FF6B35', color: '#111215' }}
                className="rounded-md px-2.5 py-1 font-mono text-xs font-extrabold tracking-wider"
              >
                /SLIDES
              </span>
              <h2 className="mt-4 font-display text-2xl font-extrabold tracking-tight text-white">
                Presentación
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-white/80">
                22 láminas interactivas con arquitectura, código y aprendizajes.
              </p>
            </div>
            <span
              style={{ color: '#FF6B35' }}
              className="mt-6 font-mono text-xs font-bold group-hover:underline"
            >
              Abrir slides →
            </span>
          </a>

          <Link
            href="/demo"
            prefetch={true}
            style={{ backgroundColor: '#1A73E8', color: '#FFFFFF', borderColor: '#1A73E8' }}
            className="group flex flex-col justify-between rounded-2xl border-2 p-6 shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <div>
              <span
                style={{ backgroundColor: '#FFFFFF', color: '#1A73E8' }}
                className="rounded-md px-2.5 py-1 font-mono text-xs font-extrabold tracking-wider"
              >
                /DEMO
              </span>
              <h2 className="mt-4 font-display text-2xl font-extrabold tracking-tight text-white">
                Simulador 3D
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-white/90">
                Clon 3D en Three.js (60 FPS), controles de hardware y los 4 demos en vivo.
              </p>
            </div>
            <span className="mt-6 font-mono text-xs font-bold text-white group-hover:underline">
              Abrir simulador →
            </span>
          </Link>

          <a
            href="https://github.com/ykro/rosorin-jsconf"
            target="_blank"
            rel="noreferrer"
            style={{ backgroundColor: '#FFFFFF', color: '#202124' }}
            className="group flex flex-col justify-between rounded-2xl border-2 border-[#DADCE0] bg-white p-6 text-[#202124] shadow-xs transition-all hover:-translate-y-0.5 hover:border-[#202124] hover:shadow-md"
          >
            <div>
              <span className="rounded-md bg-[#F1F3F4] px-2.5 py-1 font-mono text-xs font-extrabold tracking-wider text-[#202124]">
                GITHUB
              </span>
              <h2 className="mt-4 font-display text-2xl font-extrabold tracking-tight text-[#202124]">
                Repositorio
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-[#5F6368]">
                Código fuente en Next.js, puente en Rust, especificación OpenAPI y skills.
              </p>
            </div>
            <span className="mt-6 font-mono text-xs font-bold text-[#1A73E8] group-hover:underline">
              github.com/ykro/rosorin-jsconf ↗
            </span>
          </a>
        </div>
      </main>
    </div>
  );
}
