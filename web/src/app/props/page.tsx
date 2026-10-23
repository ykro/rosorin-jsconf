'use client';

import React from 'react';
import { TopNav } from '@/components/TopNav';

export default function PrintablePropsPage() {
  return (
    <div className="min-h-screen bg-[#F8F7F4] text-[#18181B]">
      <TopNav subtitle="Plantillas Imprimibles 1:1 para el Escenario (Demo B Llave de Deploy + Demo C 3 Tótems Cloud)" />

      <main className="mx-auto max-w-[1200px] px-8 py-8">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4 print:hidden">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-[#2B4ACB]">
              ASSETS FÍSICOS PARA EL ESCENARIO DE JSCONF MX
            </p>
            <h1 className="mt-1 font-display text-3xl font-bold text-[#18181B]">
              Props Imprimibles 1:1 (Pinza Servo ID 10 + Tótems de Mesa)
            </h1>
            <p className="mt-1 text-sm text-[#3F3F46]">
              Imprime esta página en cartulina opalina o pégala sobre foamboard de 5 mm. Incluye
              las medidas exactas para la pinza paralela del ROSOrin Pro y la cámara 3D Aurora 930
              Pro.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/props/rosorin-stage-props-print.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl bg-[#1A73E8] px-5 py-3 text-sm font-bold text-white hover:bg-[#1557B0]"
            >
              Abrir PDF Multipágina 1:1 (5 Páginas)
            </a>
            <button
              onClick={() => window.print()}
              className="rounded-xl border border-[#DADCE0] bg-white px-5 py-3 text-sm font-bold text-[#202124] hover:border-[#1A73E8] hover:text-[#1A73E8]"
            >
              Imprimir Vista Web (Cmd+P)
            </button>
          </div>
        </div>

        {/* Prop 1: Demo B Deploy Key for Gripper Servo ID 10 */}
        <section className="mb-10 rounded-2xl border border-[#DFDDD4] bg-white p-8 shadow-sm">
          <div className="mb-4 border-b border-[#ECEAE3] pb-3">
            <span className="font-mono text-xs font-bold uppercase text-[#0F766E]">
              PROP PARA DEMO B · PHYSICAL CI/CD GATEKEEPER
            </span>
            <h2 className="font-display text-xl font-bold text-[#18181B]">
              Tarjeta «Production Deploy Key» para Pinza Servo ID 10 (60 × 90 mm)
            </h2>
            <p className="text-xs text-[#6B6B74]">
              Instrucciones: Recorta por el borde punteado y pega sobre foamboard de 5 mm (~15 g).
              Coloca la zona superior rayada entre los dedos de la pinza y envía pulso 680 al
              Servo ID 10.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-8">
            {/* 60x90mm physical card representation */}
            <div className="flex h-[340px] w-[226px] flex-col justify-between rounded-xl border-2 border-dashed border-[#18181B] bg-[#FEF3C7] p-4 shadow-inner">
              <div className="rounded-lg border-2 border-[#18181B] bg-[#18181B] p-2.5 text-center text-[#F8F7F4]">
                <span className="block font-mono text-[10px] uppercase tracking-widest text-[#FBBF24]">
                  ZONA DE AGARRE SERVO ID 10
                </span>
                <span className="font-mono text-xs font-bold">PULSO CERRADO: 680</span>
              </div>

              <div className="my-auto text-center">
                <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-[#B45309]">
                  JSCONF MX 2026
                </p>
                <p className="mt-1 font-display text-2xl font-bold leading-tight text-[#18181B]">
                  PRODUCTION DEPLOY KEY
                </p>
                <div className="mx-auto my-3 h-12 w-12 rounded-lg border-2 border-[#18181B] bg-white p-1.5 font-mono text-[9px] font-bold leading-tight text-[#18181B]">
                  SHA
                  <br />
                  #408
                  <br />
                  LIVE
                </div>
              </div>

              <div className="border-t border-[#B45309]/40 pt-2 text-center font-mono text-[10px] text-[#18181B]">
                RELEASE_DEPLOY_KEY() → PULSO 220
              </div>
            </div>

            {/* Two target tray labels */}
            <div className="flex flex-1 flex-col gap-4">
              <div className="rounded-xl border-2 border-dashed border-[#0F766E] bg-[#0F766E]/10 p-5">
                <span className="font-mono text-xs font-bold uppercase text-[#0F766E]">
                  ETIQUETA BANDEJA IZQUIERDA (JOINT 1 = 680)
                </span>
                <p className="mt-1 font-display text-2xl font-bold text-[#0F766E]">
                  DEPLOY APPROVED · GREEN TRAY
                </p>
                <p className="mt-1 font-mono text-xs text-[#3F3F46]">
                  Colocar a 18 cm a la izquierda de la base del brazo.
                </p>
              </div>

              <div className="rounded-xl border-2 border-dashed border-[#DC2626] bg-[#DC2626]/10 p-5">
                <span className="font-mono text-xs font-bold uppercase text-[#DC2626]">
                  ETIQUETA BANDEJA DERECHA (JOINT 1 = 260)
                </span>
                <p className="mt-1 font-display text-2xl font-bold text-[#DC2626]">
                  DEPLOY REJECTED · ROLLBACK TRAY
                </p>
                <p className="mt-1 font-mono text-xs text-[#3F3F46]">
                  Colocar a 18 cm a la derecha de la base del brazo.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Prop 2: Demo C 3 Service Totems */}
        <section className="rounded-2xl border border-[#DFDDD4] bg-white p-8 shadow-sm">
          <div className="mb-4 border-b border-[#ECEAE3] pb-3">
            <span className="font-mono text-xs font-bold uppercase text-[#2B4ACB]">
              PROPS PARA DEMO C · SPATIAL BUG HUNTER
            </span>
            <h2 className="font-display text-xl font-bold text-[#18181B]">
              3 Tótems Físicos de Microservicios para la Mesa (X = +42 cm frente al robot)
            </h2>
            <p className="text-xs text-[#6B6B74]">
              Instrucciones: Recorta y dobla en forma de prisma triangular de pie. Colócalos a 42 cm
              frente al robot separados 20 cm entre sí (Izquierda Y=+20cm, Centro Y=0cm, Derecha
              Y=-20cm).
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {[
              {
                id: 'TOTEM 01 · IZQUIERDA (Y = +20 cm)',
                title: 'CLOUD RUN',
                subtitle: 'API & WebSocket Gateway',
                color: '#2B4ACB',
                pose: 'Strafe Izq · Joint 1 = 560',
              },
              {
                id: 'TOTEM 02 · CENTRO (Y = 0 cm)',
                title: 'GEMINI LIVE',
                subtitle: 'Native PCM 16kHz / 24kHz',
                color: '#0F766E',
                pose: 'Centro · Joint 1 = 500',
              },
              {
                id: 'TOTEM 03 · DERECHA (Y = -20 cm)',
                title: 'FIRESTORE',
                subtitle: 'State & Telemetry Index',
                color: '#B45309',
                pose: 'Strafe Der · Joint 1 = 440',
              },
            ].map((totem) => (
              <div
                key={totem.title}
                className="flex flex-col justify-between rounded-2xl border-2 border-dashed border-[#18181B] p-6 text-center"
              >
                <div
                  className="rounded-lg py-1.5 font-mono text-[10px] font-bold uppercase text-white"
                  style={{ backgroundColor: totem.color }}
                >
                  {totem.id}
                </div>

                <div className="my-8">
                  <div
                    className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-xl border-4 border-[#18181B] font-mono text-lg font-bold text-white"
                    style={{ backgroundColor: totem.color }}
                  >
                    {totem.title.slice(0, 2)}
                  </div>
                  <h3 className="font-display text-2xl font-bold text-[#18181B]">
                    {totem.title}
                  </h3>
                  <p className="mt-1 font-mono text-xs text-[#6B6B74]">{totem.subtitle}</p>
                </div>

                <div className="border-t border-[#DFDDD4] pt-3 font-mono text-[11px] text-[#3F3F46]">
                  <div>{totem.pose}</div>
                  <div className="mt-1 text-[10px] text-[#6B6B74]">
                    --- DOBLAR BASE 4 CM AQUÍ ---
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
