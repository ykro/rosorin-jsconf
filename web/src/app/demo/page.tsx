'use client';

import React, { useEffect } from 'react';
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
        {/* Left Side: Collapsible API Key + Hardware Control Panel (demos live in the TopNav) */}
        <section className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <ApiKeyCollapsible />

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
