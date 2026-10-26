'use client';

import React, { useEffect, useState } from 'react';
import { useRobotTelemetry } from '@/lib/use-robot-telemetry';
import { stopAllActiveConversations } from '@/lib/gemini-live';
import { BridgeAlerts } from '@/components/BridgeControls';

export default function RobotFacePage() {
  const { telemetry, triggerGesture, client, bridge, emergencyStop, releaseEstop } = useRobotTelemetry();

  const [blinking, setBlinking] = useState(false);
  const [talkPhase, setTalkPhase] = useState(0);

  // Natural blink every 3.6 seconds
  useEffect(() => {
    const blinkInterval = setInterval(() => {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 140);
    }, 3600);
    return () => clearInterval(blinkInterval);
  }, []);

  const isSpeaking = Boolean(telemetry.speaking);
  const isListening = Boolean(telemetry.listening);

  // Mouth animation only while speaking (no 60 ms re-render loop when idle).
  useEffect(() => {
    if (!isSpeaking) return;
    const anim = setInterval(() => {
      setTalkPhase((p) => (p + 1) % 60);
    }, 80);
    return () => clearInterval(anim);
  }, [isSpeaking]);

  // Track Servo 1 (base yaw: 120..880, center 500) and Servo 4 (wrist pitch: center 380)
  const servo1 = telemetry.servos['1'] ?? 500;
  const servo4 = telemetry.servos['4'] ?? 380;

  const gazeX = Math.max(-38, Math.min(38, -((servo1 - 500) / 180) * 34));
  const gazeY = Math.max(-20, Math.min(20, -((servo4 - 380) / 180) * 16));

  const gesture = telemetry.active_gesture || 'home';
  const mood = (telemetry.mood || 'attentive').toLowerCase();
  const obstacleAlert =
    telemetry.lidar?.obstacle_alert || (telemetry.lidar?.front_m ?? 1.5) < 0.25;

  type Expression = 'friendly' | 'happy' | 'roasting' | 'focused';
  let expression: Expression = 'friendly';
  let primaryColor = '#4285F4'; // Google Blue

  if (obstacleAlert) {
    expression = 'roasting';
    primaryColor = '#EA4335'; // Google Red
  } else if (
    gesture === 'gatekeeper_approve' ||
    gesture === 'chef_kiss' ||
    gesture === 'victory_spin' ||
    gesture === 'nod_yes' ||
    gesture === 'wave_hello' ||
    gesture === 'bumblebee_hype' ||
    gesture === 'bumblebee_groove' ||
    gesture === 'bumblebee_romance' ||
    mood.includes('approv') ||
    mood.includes('impress') ||
    mood.includes('celebrat') ||
    mood.includes('happy') ||
    mood.includes('love')
  ) {
    expression = 'happy';
    primaryColor = '#34A853'; // Google Green
  } else if (
    gesture === 'gatekeeper_reject' ||
    gesture === 'facepalm' ||
    gesture === 'trash_toss' ||
    gesture === 'shake_no' ||
    gesture === 'bumblebee_rock_out' ||
    gesture === 'bumblebee_sad_droop' ||
    mood.includes('reject') ||
    mood.includes('roast') ||
    mood.includes('angry') ||
    mood.includes('sad')
  ) {
    expression = 'roasting';
    primaryColor = '#EA4335'; // Google Red
  } else if (
    gesture === 'gatekeeper_hold' ||
    gesture === 'suspicious_inspect' ||
    gesture === 'point_firestore' ||
    gesture === 'bumblebee_sassy' ||
    mood.includes('guard') ||
    mood.includes('skeptic') ||
    mood.includes('question') ||
    mood.includes('confused')
  ) {
    expression = 'focused';
    primaryColor = '#FBBC04'; // Google Yellow
  } else if (gesture === 'point_gemini_live') {
    expression = 'focused';
    primaryColor = '#34A853';
  } else if (gesture === 'point_cloud_run') {
    expression = 'focused';
    primaryColor = '#4285F4';
  }

  const handleTap = () => {
    if (isSpeaking) {
      stopAllActiveConversations('user');
      void client?.updateHud({ speaking: false });
    } else {
      void triggerGesture('wave_hello', 'impressed');
    }
  };

  // Dynamic mouth openness when speaking
  const talkOpen = isSpeaking
    ? 18 + Math.abs(Math.sin(talkPhase * 0.7)) * 38
    : 0;

  return (
    <div
      onClick={handleTap}
      style={{ backgroundColor: '#0E1117' }}
      className="relative flex h-screen w-screen cursor-pointer select-none items-center justify-center overflow-hidden"
    >
      <BridgeAlerts bridge={bridge} onReleaseEstop={releaseEstop} />
      {bridge.enabled && !bridge.estopLatched && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void emergencyStop();
          }}
          className="absolute bottom-4 right-4 z-10 rounded-xl bg-[#D93025] px-4 py-3 text-sm font-extrabold text-white shadow-lg hover:bg-[#B3261E]"
        >
          PARO
        </button>
      )}
      <svg
        viewBox="0 0 1000 600"
        className="h-full w-full"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="1000" height="600" fill="#0E1117" />
        <defs>
          <radialGradient id="eyeGlow" cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor={primaryColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={primaryColor} stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Soft ambient glow behind eyes */}
        <circle cx={310 + gazeX * 0.5} cy={250 + gazeY * 0.5} r="180" fill="url(#eyeGlow)" />
        <circle cx={690 + gazeX * 0.5} cy={250 + gazeY * 0.5} r="180" fill="url(#eyeGlow)" />

        {/* ==================== EYEBROWS ==================== */}
        {expression === 'friendly' && (
          <>
            <path
              d={`M ${220 + gazeX * 0.3} ${115 + gazeY * 0.3} Q ${310 + gazeX * 0.3} ${92 + gazeY * 0.3} ${400 + gazeX * 0.3} ${115 + gazeY * 0.3}`}
              fill="none"
              stroke={primaryColor}
              strokeWidth="12"
              strokeLinecap="round"
            />
            <path
              d={`M ${600 + gazeX * 0.3} ${115 + gazeY * 0.3} Q ${690 + gazeX * 0.3} ${92 + gazeY * 0.3} ${780 + gazeX * 0.3} ${115 + gazeY * 0.3}`}
              fill="none"
              stroke={primaryColor}
              strokeWidth="12"
              strokeLinecap="round"
            />
          </>
        )}

        {expression === 'happy' && (
          <>
            <path
              d={`M ${215 + gazeX * 0.3} ${105 + gazeY * 0.3} Q ${310 + gazeX * 0.3} ${70 + gazeY * 0.3} ${405 + gazeX * 0.3} ${105 + gazeY * 0.3}`}
              fill="none"
              stroke={primaryColor}
              strokeWidth="14"
              strokeLinecap="round"
            />
            <path
              d={`M ${595 + gazeX * 0.3} ${105 + gazeY * 0.3} Q ${690 + gazeX * 0.3} ${70 + gazeY * 0.3} ${785 + gazeX * 0.3} ${105 + gazeY * 0.3}`}
              fill="none"
              stroke={primaryColor}
              strokeWidth="14"
              strokeLinecap="round"
            />
          </>
        )}

        {expression === 'roasting' && (
          <>
            {/* Furrowed V-brows */}
            <line
              x1={210 + gazeX * 0.3}
              y1={95 + gazeY * 0.3}
              x2={410 + gazeX * 0.3}
              y2={138 + gazeY * 0.3}
              stroke={primaryColor}
              strokeWidth="16"
              strokeLinecap="round"
            />
            <line
              x1={790 + gazeX * 0.3}
              y1={95 + gazeY * 0.3}
              x2={590 + gazeX * 0.3}
              y2={138 + gazeY * 0.3}
              stroke={primaryColor}
              strokeWidth="16"
              strokeLinecap="round"
            />
          </>
        )}

        {expression === 'focused' && (
          <>
            {/* One raised skeptical brow, one flat scanner brow */}
            <line
              x1={210 + gazeX * 0.3}
              y1={122 + gazeY * 0.3}
              x2={410 + gazeX * 0.3}
              y2={118 + gazeY * 0.3}
              stroke={primaryColor}
              strokeWidth="14"
              strokeLinecap="round"
            />
            <path
              d={`M ${590 + gazeX * 0.3} ${118 + gazeY * 0.3} Q ${690 + gazeX * 0.3} ${72 + gazeY * 0.3} ${790 + gazeX * 0.3} ${108 + gazeY * 0.3}`}
              fill="none"
              stroke={primaryColor}
              strokeWidth="14"
              strokeLinecap="round"
            />
          </>
        )}

        {/* ==================== LEFT & RIGHT EYES ==================== */}
        {[310, 690].map((cx, idx) => {
          if (blinking) {
            return (
              <path
                key={idx}
                d={`M ${cx - 105 + gazeX} ${255 + gazeY} Q ${cx + gazeX} ${275 + gazeY} ${cx + 105 + gazeX} ${255 + gazeY}`}
                fill="none"
                stroke={primaryColor}
                strokeWidth="16"
                strokeLinecap="round"
              />
            );
          }

          if (expression === 'happy') {
            // Smiling arched anime/robot eyes (^ ^)
            return (
              <g key={idx} transform={`translate(${gazeX}, ${gazeY})`}>
                <path
                  d={`M ${cx - 95} 275 Q ${cx} 155 ${cx + 95} 275`}
                  fill="none"
                  stroke={primaryColor}
                  strokeWidth="26"
                  strokeLinecap="round"
                />
              </g>
            );
          }

          return (
            <g key={idx}>
              {/* Outer Sclera / Eye Socket */}
              <ellipse
                cx={cx + gazeX * 0.35}
                cy={255 + gazeY * 0.35}
                rx="112"
                ry={expression === 'focused' ? 86 : 108}
                fill="#141B26"
                stroke={primaryColor}
                strokeWidth="10"
              />

              {/* Glowing Iris */}
              <circle
                cx={cx + gazeX}
                cy={255 + gazeY}
                r={expression === 'focused' ? 54 : 64}
                fill={primaryColor}
              />

              {/* Inner Dark Pupil */}
              <circle
                cx={cx + gazeX * 1.15}
                cy={255 + gazeY * 1.15}
                r="28"
                fill="#0B0F17"
              />

              {/* Primary + Secondary White Catchlights (gives life to the eyes) */}
              <circle
                cx={cx - 22 + gazeX * 1.1}
                cy={230 + gazeY * 1.1}
                r="15"
                fill="#FFFFFF"
              />
              <circle
                cx={cx + 20 + gazeX * 1.1}
                cy={276 + gazeY * 1.1}
                r="7"
                fill="#FFFFFF"
                opacity="0.85"
              />
            </g>
          );
        })}

        {/* ==================== MOUTH ==================== */}
        {isSpeaking ? (
          /* Animated Talking Mouth */
          <g transform={`translate(${gazeX * 0.25}, ${gazeY * 0.25})`}>
            <rect
              x={500 - 85}
              y={455 - talkOpen / 2}
              width="170"
              height={Math.max(20, talkOpen)}
              rx={Math.min(40, talkOpen / 2)}
              fill="#141B26"
              stroke={primaryColor}
              strokeWidth="12"
            />
            {/* Inner tongue/voice glow */}
            {talkOpen > 28 && (
              <ellipse
                cx="500"
                cy={455 + talkOpen * 0.18}
                rx="46"
                ry={talkOpen * 0.22}
                fill={primaryColor}
                opacity="0.65"
              />
            )}
          </g>
        ) : expression === 'happy' ? (
          /* Big Happy Open Smile */
          <path
            d={`M ${400 + gazeX * 0.25} 435 Q 500 535 ${600 + gazeX * 0.25} 435 Z`}
            fill={primaryColor}
            fillOpacity="0.25"
            stroke={primaryColor}
            strokeWidth="14"
            strokeLinejoin="round"
          />
        ) : expression === 'roasting' ? (
          /* Skeptical / Unimpressed Frown */
          <path
            d={`M ${415 + gazeX * 0.25} 485 Q 500 430 ${585 + gazeX * 0.25} 485`}
            fill="none"
            stroke={primaryColor}
            strokeWidth="14"
            strokeLinecap="round"
          />
        ) : expression === 'focused' ? (
          /* Asymmetric Thinking Smirk */
          <path
            d={`M ${420 + gazeX * 0.25} 465 Q 500 470 ${585 + gazeX * 0.25} 440`}
            fill="none"
            stroke={primaryColor}
            strokeWidth="14"
            strokeLinecap="round"
          />
        ) : (
          /* Default Friendly Smile */
          <path
            d={`M ${410 + gazeX * 0.25} 445 Q 500 510 ${590 + gazeX * 0.25} 445`}
            fill="none"
            stroke={primaryColor}
            strokeWidth="14"
            strokeLinecap="round"
          />
        )}

        {/* Subtle Listening Indicator Dot at bottom when mic is active */}
        {isListening && !isSpeaking && (
          <circle cx="500" cy="560" r="8" fill="#34A853" />
        )}
      </svg>
    </div>
  );
}
