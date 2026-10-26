'use client';

import React, { useEffect } from 'react';
import { TopNav } from '@/components/TopNav';
import { HardwareControlPanel } from '@/components/HardwareControlPanel';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import { shouldIgnoreShortcut } from '@/lib/keyboard';

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
