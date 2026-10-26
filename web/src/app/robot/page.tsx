'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { TopNav } from '@/components/TopNav';
import { HardwareControlPanel } from '@/components/HardwareControlPanel';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import { shouldIgnoreShortcut } from '@/lib/keyboard';

const LITE_DEMOS = [
  {
    tag: 'DEMO A',
    title: 'Repo Roaster',
    href: '/demos/roaster?lite=1',
    bgClass: 'bg-[#1A73E8] border-[#1A73E8] hover:bg-[#1557B0] text-white',
    tagClass: 'bg-white/20 text-white',
  },
  {
    tag: 'DEMO B',
    title: 'Gatekeeper CI/CD',
    href: '/demos/gatekeeper?lite=1',
    bgClass: 'bg-[#1E8E3E] border-[#1E8E3E] hover:bg-[#137333] text-white',
    tagClass: 'bg-white/20 text-white',
  },
  {
    tag: 'DEMO C',
    title: 'Bug Hunter',
    href: '/demos/bughunter?lite=1',
    bgClass: 'bg-[#F9AB00] border-[#F9AB00] hover:bg-[#EA8600] text-[#202124]',
    tagClass: 'bg-white/70 text-[#202124]',
  },
  {
    tag: 'DEMO D',
    title: 'Bumblebee Radio',
    href: '/demos/bumblebee?lite=1',
    bgClass: 'bg-[#EA4335] border-[#EA4335] hover:bg-[#C5221F] text-white',
    tagClass: 'bg-white/20 text-white',
  },
];

export default function RobotLiteHubPage() {
  const robot = useRobotTelemetry();
  const { telemetry, jogServo, setServoPulse, moveChassis, triggerGesture, resetScene } = robot;

  useEffect(() => {
    try {
      window.localStorage.setItem('ROSORIN_LITE_MODE', '1');
    } catch (err) {
      console.warn('[robot] localStorage no disponible:', err);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (shouldIgnoreShortcut(e)) return;

      const key = e.key.toLowerCase();
      switch (key) {
        case '1':
          jogServo(1, 35);
          break;
        case 'q':
          jogServo(1, -35);
          break;
        case '2':
          jogServo(2, 35);
          break;
        case 'w':
          jogServo(2, -35);
          break;
        case '3':
          jogServo(3, 35);
          break;
        case 'e':
          jogServo(3, -35);
          break;
        case '4':
          jogServo(4, 35);
          break;
        case 'r':
          jogServo(4, -35);
          break;
        case '5':
          jogServo(5, 35);
          break;
        case 't':
          jogServo(5, -35);
          break;
        case 'o':
          setServoPulse(10, 220);
          break;
        case 'c':
          setServoPulse(10, 680);
          break;
        case 'arrowup':
          e.preventDefault();
          moveChassis(0.15, 0, 0);
          break;
        case 'arrowdown':
          e.preventDefault();
          moveChassis(-0.15, 0, 0);
          break;
        case 'arrowleft':
          e.preventDefault();
          moveChassis(0, 0.15, 0);
          break;
        case 'arrowright':
          e.preventDefault();
          moveChassis(0, -0.15, 0);
          break;
        case 'f':
          triggerGesture('facepalm', 'manual');
          break;
        case 'g':
          triggerGesture('trash_toss', 'manual');
          break;
        case 'h':
          triggerGesture('chef_kiss', 'manual');
          break;
        case 'v':
          triggerGesture('victory_spin', 'manual');
          break;
        case '0':
          resetScene();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [jogServo, setServoPulse, moveChassis, triggerGesture, resetScene]);

  return (
    <div className="flex min-h-screen w-screen flex-col bg-[#F8F9FA] text-[#202124]">
      <TopNav robot={robot} liteMode={true} />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 p-6">
        {/* 4 Large Google-Colored Stage Launch Buttons */}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {LITE_DEMOS.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              prefetch={true}
              className={`group flex h-[116px] flex-col justify-between rounded-2xl border-2 p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-95 ${d.bgClass}`}
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
        </section>

        {/* Balanced 2-Column Hardware Studio Console */}
        <HardwareControlPanel
          telemetry={telemetry}
          sceneMode="default"
          onJogServo={jogServo}
          onSetServoPulse={setServoPulse}
          onMoveChassis={(vx, vy, wz) => moveChassis(vx, vy, wz)}
          onTriggerGesture={(g) => triggerGesture(g, 'manual')}
          onResetScene={resetScene}
        />
      </main>
    </div>
  );
}
