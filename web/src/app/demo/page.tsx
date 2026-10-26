'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { TopNav } from '@/components/TopNav';
import { ApiKeyCollapsible } from '@/components/ApiKeyCollapsible';
import { HardwareControlPanel } from '@/components/HardwareControlPanel';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import RobotLiteHubPage from '../robot/page';

const Rosorin3DViewer = dynamic(
  () => import('@/components/Rosorin3DViewer').then((m) => m.Rosorin3DViewer),
  { ssr: false }
);

const HUB_DEMOS = [
  {
    tag: 'DEMO A',
    title: 'Repo Roaster',
    href: '/demos/roaster',
    bgClass: 'bg-[#1A73E8] border-[#1A73E8] hover:bg-[#1557B0] text-white',
    tagClass: 'bg-white/20 text-white',
  },
  {
    tag: 'DEMO B',
    title: 'Gatekeeper CI/CD',
    href: '/demos/gatekeeper',
    bgClass: 'bg-[#1E8E3E] border-[#1E8E3E] hover:bg-[#137333] text-white',
    tagClass: 'bg-white/20 text-white',
  },
  {
    tag: 'DEMO C',
    title: 'Bug Hunter',
    href: '/demos/bughunter',
    bgClass: 'bg-[#F9AB00] border-[#F9AB00] hover:bg-[#EA8600] text-[#202124]',
    tagClass: 'bg-white/70 text-[#202124]',
  },
  {
    tag: 'DEMO D',
    title: 'Bumblebee Radio',
    href: '/demos/bumblebee',
    bgClass: 'bg-[#EA4335] border-[#EA4335] hover:bg-[#C5221F] text-white',
    tagClass: 'bg-white/20 text-white',
  },
];

export default function DemoSimulatorPage() {
  const robot = useRobotTelemetry();
  const { telemetry, jogServo, setServoPulse, moveChassis, simulateLidar, triggerGesture, resetScene } =
    robot;

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_LITE_MODE !== '1') {
      try {
        window.localStorage.removeItem('ROSORIN_LITE_MODE');
      } catch (err) {
        console.warn('[demo] localStorage no disponible:', err);
      }
    }
  }, []);

  if (process.env.NEXT_PUBLIC_LITE_MODE === '1') {
    return <RobotLiteHubPage />;
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#F8F9FA] text-[#202124]">
      <TopNav robot={robot} liteMode={false} />

      <main className="flex h-[calc(100vh-56px)] w-full overflow-hidden">
        {/* Left Side: Collapsible API Key + 4 Demo Buttons + Hardware Control Panel */}
        <section className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <ApiKeyCollapsible />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {HUB_DEMOS.map((d) => (
              <Link
                key={d.href}
                href={d.href}
                prefetch={true}
                className={`group flex h-[112px] flex-col justify-between rounded-2xl border-2 p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-95 ${d.bgClass}`}
              >
                <div>
                  <span
                    className={`rounded-md px-2.5 py-1 font-mono text-xs font-bold tracking-wider ${d.tagClass}`}
                  >
                    {d.tag}
                  </span>
                </div>

                <span className="font-display text-2xl font-extrabold tracking-tight">
                  {d.title}
                </span>
              </Link>
            ))}
          </div>

          <HardwareControlPanel
            telemetry={telemetry}
            sceneMode="default"
            onJogServo={jogServo}
            onSetServoPulse={setServoPulse}
            onMoveChassis={(vx, vy, wz) => moveChassis(vx, vy, wz)}
            onTriggerGesture={(g) => triggerGesture(g, 'manual')}
            onResetScene={resetScene}
          />
        </section>

        {/* Right Side: 3D Robot Model */}
        <aside className="flex w-[440px] lg:w-[520px] shrink-0 flex-col overflow-hidden border-l border-[#DADCE0]">
          <Rosorin3DViewer
            telemetry={telemetry}
            sceneMode="sandbox"
            enableKeyboard={true}
            onJogServo={jogServo}
            onMoveChassis={moveChassis}
            onSimulateLidar={simulateLidar}
            onTriggerGesture={(g) => triggerGesture(g, 'manual')}
            onResetScene={resetScene}
          />
        </aside>
      </main>
    </div>
  );
}
