'use client';

import { useEffect, useRef, useState } from 'react';
import { EmbodiedGeminiLiveSession, type LiveStatus } from './gemini-live';
import type { RobotActionHandler } from './types';

/**
 * Shared state + lifecycle for demos A, B and C (one Gemini Live session per page).
 * The session is disposed on unmount (mic, Live socket and playback AudioContext).
 */
export function useEmbodiedLiveSession(
  robot: RobotActionHandler,
  onVerdictGesture?: (gesture: string) => void
) {
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('idle');
  const [speaking, setSpeaking] = useState(false);
  const [conversationActive, setConversationActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micWarning, setMicWarning] = useState<string | null>(null);
  const [userTranscript, setUserTranscript] = useState('');
  const [verdictHeadline, setVerdictHeadline] = useState('');

  const sessionRef = useRef<EmbodiedGeminiLiveSession | null>(null);
  const gestureCbRef = useRef(onVerdictGesture);
  useEffect(() => {
    gestureCbRef.current = onVerdictGesture;
  }, [onVerdictGesture]);

  const { triggerGesture, moveChassis } = robot;

  useEffect(() => {
    const session = new EmbodiedGeminiLiveSession(
      { triggerGesture, moveChassis },
      {
        onStatus: setLiveStatus,
        onTranscript: (role, text) => {
          if (!text.trim()) return;
          if (role === 'robot') setVerdictHeadline(text);
          else setUserTranscript(text);
        },
        onVerdictHeadline: (headline, gesture) => {
          if (headline) setVerdictHeadline(headline);
          gestureCbRef.current?.(gesture);
        },
        onSpeakingChange: setSpeaking,
        onConversationActiveChange: setConversationActive,
        onMicLevelChange: setMicLevel,
        onMicWarning: setMicWarning,
      }
    );
    sessionRef.current = session;
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [triggerGesture, moveChassis]);

  return {
    sessionRef,
    setVerdictHeadline,
    consoleProps: {
      status: liveStatus,
      speaking,
      externalActive: conversationActive,
      micLevel,
      micWarning,
      userTranscript,
      verdictHeadline,
      onSendBargeIn: (text: string) => void sessionRef.current?.sendUserDefense(text),
      onStopContinuous: () => sessionRef.current?.stopContinuousConversation('user'),
      onInterruptSpeech: () => sessionRef.current?.interruptRobotSpeech(),
    },
  };
}
