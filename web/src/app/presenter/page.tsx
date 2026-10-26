'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { TelemetryState } from '@/lib/types';
import { PRESET_REPOS } from '@/lib/repo-analyzer';
import { FALLBACK_TELEMETRY, RobotBridgeClient, describeBridgeError } from '@/lib/robot-client';

export default function PresenterPage() {
  const [telemetry, setTelemetry] = useState<TelemetryState>(FALLBACK_TELEMETRY);
  const [selectedSlug, setSelectedSlug] = useState('legacy-js/todo-400-deps');
  const analysis = PRESET_REPOS[selectedSlug] || PRESET_REPOS['legacy-js/todo-400-deps'];

  useEffect(() => {
    const client = new RobotBridgeClient(undefined, (st) => setTelemetry(st));
    client.connectWebSocket();
    return () => client.disconnect();
  }, []);

  async function fireRoast(slug: string) {
    setSelectedSlug(slug);
    const item = PRESET_REPOS[slug];
    if (!item) return;
    const client = new RobotBridgeClient();
    try {
      await client.triggerGesture(item.suggestedGesture, 'stage_roast');
    } catch (err) {
      const { code, message } = describeBridgeError(err);
      if (code !== 'disabled') console.warn(`[presenter] Gesto no enviado (${code}): ${message}`);
    }
  }

  return (
    <div
      style={{
        width: '100vw',
        minHeight: '100vh',
        background: '#F8F7F4',
        color: '#18181B',
        padding: '56px 80px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div
            style={{
              width: 12,
              height: 64,
              background: '#0F766E',
              borderRadius: 6,
            }}
          />
          <h1 style={{ fontSize: 52, fontWeight: 800, letterSpacing: '-1px' }}>
            ROSOrin Pro · Revisor de código físico
          </h1>
        </div>
        <Link
          href="/"
          className="mono"
          style={{
            fontSize: 20,
            color: '#6B6B74',
            textDecoration: 'none',
            padding: '10px 20px',
            border: '2px solid #DFDDD4',
            borderRadius: 12,
          }}
        >
          ← Consola completa
        </Link>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.3fr 0.7fr',
          gap: 48,
          alignItems: 'center',
          margin: '36px 0',
        }}
      >
        <div
          style={{
            background: '#FFFFFF',
            border: '2px solid #DFDDD4',
            borderTop: '12px solid #0F766E',
            borderRadius: 24,
            padding: 48,
          }}
        >
          <div
            className="mono"
            style={{ fontSize: 26, color: '#0F766E', fontWeight: 700, marginBottom: 16 }}
          >
            {analysis.repo} · {analysis.dependencyCount ?? 'n/d'} paquetes
          </div>
          <p
            style={{
              fontSize: 44,
              fontWeight: 800,
              lineHeight: 1.2,
              marginBottom: 32,
            }}
          >
            “{analysis.roastHeadline}”
          </p>
          <div style={{ display: 'flex', gap: 16 }}>
            {Object.keys(PRESET_REPOS).map((slug) => (
              <button
                key={slug}
                onClick={() => fireRoast(slug)}
                className="mono"
                style={{
                  padding: '16px 24px',
                  fontSize: 22,
                  fontWeight: 700,
                  borderRadius: 14,
                  border: '2px solid #18181B',
                  background: selectedSlug === slug ? '#18181B' : '#F8F7F4',
                  color: selectedSlug === slug ? '#F8F7F4' : '#18181B',
                }}
              >
                {slug}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            background: '#FFFFFF',
            border: '2px solid #DFDDD4',
            borderTop: '12px solid #BE185D',
            borderRadius: 24,
            padding: 48,
            textAlign: 'center',
          }}
        >
          <div className="mono" style={{ fontSize: 24, color: '#6B6B74' }}>
            VEREDICTO FÍSICO
          </div>
          <div
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 150,
              fontWeight: 800,
              lineHeight: 1,
              color: analysis.roastScore < 50 ? '#991B1B' : '#0F766E',
              margin: '16px 0',
            }}
          >
            {analysis.roastScore}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 28,
              fontWeight: 700,
              padding: '12px 20px',
              background: '#F1F0EC',
              borderRadius: 14,
            }}
          >
            Gesto 6-DOF: {telemetry.active_gesture}
          </div>
        </div>
      </div>

      <footer
        className="mono"
        style={{
          fontSize: 24,
          color: '#6B6B74',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>Adrián Catalán · @adriancs.tech · JSConf MX 2026</span>
        <span>
          Batería {(telemetry.battery_mv / 1000).toFixed(2)}V · LiDAR{' '}
          {telemetry.lidar.front_m.toFixed(2)}m · Pinza ID10={telemetry.servos['10'] ?? 500}
        </span>
      </footer>
    </div>
  );
}
