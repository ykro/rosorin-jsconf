---
name: gemini-live-js
description: Use when building real-time multimodal voice, vision, and embodied hardware agents in JavaScript/TypeScript with @google/genai Gemini Live API — WebSocket session lifecycle, 16kHz/24kHz Web Audio PCM streaming, barge-in interruption, tool calling for robotics, and Google Cloud Run deployment.
---

# Gemini Live API in JavaScript & TypeScript — Embodied AI Reference

## Overview

The Gemini Live API (`@google/genai`) provides stateful, low-latency bidirectional WebSocket streaming for audio, video, text, and synchronous function calling. In an **Embodied AI** architecture, JavaScript orchestrates the multimodal stream in the browser/Node runtime while dispatching physical actuation tool calls to a local Rust/ROS 2 hardware bridge (`robot-bridge :9000`).

## Architecture: Cloud + Browser + Local ROS 2 Bridge

```text
Browser (Next.js / TS)                    Google Cloud                     ROSOrin Pro (Jetson Orin)
┌─────────────────────────────────┐      ┌──────────────────────────┐     ┌─────────────────────────────┐
│ Web Audio (16kHz in / 24kHz out)│◄────►│ Gemini Live API (WSS)    │     │ robot-bridge (Rust :9000)   │
│ @google/genai ai.live.connect   │      │ gemini-3.8-live          │     │ ├─ WS /ws (20Hz telemetry)  │
│                                 │      ├──────────────────────────┤     │ ├─ POST /gesture (6-DOF+base)│
│ Tool Call Dispatcher ───────────┼──────► Cloud Run Repo Analyzer  │     │ ├─ POST /cmd_vel (watchdog) │
│   ├─ express_verdict()          │      │ (/api/analyze-repo)      │     │ └─ GET /camera/frame (JPEG) │
│   ├─ move_chassis() ────────────┼──────┼──────────────────────────┼────►│                             │
│   ├─ control_arm()              │      └──────────────────────────┘     └──────────────┬──────────────┘
│   └─ inspect_with_camera()      │                                                      ▼
└─────────────────────────────────┘                                       ROS 2 Humble / STM32 (/dev/rrc)
```

## Session Setup (`@google/genai` TypeScript)

Never hardcode model IDs; read from `process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL` (default: `gemini-3.8-live`, see https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live). Note that in `gemini-3.8-live`, asynchronous function calling (`behavior: NON_BLOCKING`) is the default mode and `proactive_audio` is permanently enabled.

```typescript
import { GoogleGenAI, Modality, Type, FunctionDeclaration } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: ephemeralOrApiKey });
const model = process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL || 'gemini-3.8-live';

const session = await ai.live.connect({
  model,
  config: {
    responseModalities: [Modality.AUDIO], // MUST be AUDIO for voice (TEXT triggers 1011)
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT_ENGLISH }],
    },
    speechConfig: {
      languageCode: lang === 'es' ? 'es-US' : 'en-US', // Pin languageCode to prevent voice timbre drift
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: 'Kore' }, // Or 'Puck', 'Fenrir', 'Zephyr'
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', // Prevents servo/speaker echo false triggers
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        silenceDurationMs: 250, // Fast turn-taking for stage demos
      },
    },
    tools: [{ functionDeclarations: ROBOT_TOOLS }],
  },
  callbacks: {
    onopen: () => onStatusChange('connected'),
    onmessage: (msg) => handleServerMessage(msg),
    onerror: (err) => console.error('Live error:', err),
    onclose: () => onStatusChange('disconnected'),
  },
});
```

## Audio Pipeline in the Browser (16kHz Input / 24kHz Output)

1. **Microphone Input (16kHz, 16-bit PCM mono, base64):**
   - Capture via `AudioContext({ sampleRate: 16000 })` + `AudioWorkletNode` (or `ScriptProcessorNode` fallback).
   - Convert `Float32Array` `[-1.0, 1.0]` to `Int16Array`, encode as base64, and send via:
     ```typescript
     session.sendRealtimeInput({
       audio: { data: base64Pcm16k, mimeType: 'audio/pcm;rate=16000' },
     });
     ```
2. **Echo & Servo Noise Suppression (Three Layers):**
   - **Layer 1 (Motion Suppression):** While the 6-DOF arm servos or Mecanum motors are moving (`motionSuppressUntil > Date.now()`), send silence chunks (`new Int16Array(chunkLen)`) unless the user's voice RMS exceeds `INTERRUPT_RMS * 1.5`. Servos make mechanical noise that Gemini VAD can mistake for user speech.
   - **Layer 2 (Speaker Playback Gate + Speaking Tail):** While the robot is speaking (plus a `250ms` speaking tail after the last audio chunk finishes playing), gate microphone audio unless `rms > INTERRUPT_RMS` (user barge-in).
   - **Layer 3 (Barge-In Queue Flush):** When `msg.serverContent?.interrupted` is `true`, immediately stop all scheduled `AudioBufferSourceNode`s and reset `nextPlayTime = audioCtx.currentTime` so the robot stops talking in `<20ms`—AND optionally send a quick stop/attentive pose to the robot!
3. **Gapless 24kHz PCM Playback:**
   - Decode incoming base64 16-bit PCM at `24000 Hz` into a `Float32Array`, copy into `audioCtx.createBuffer(1, samples.length, 24000)`, and schedule at `Math.max(audioCtx.currentTime + 0.02, nextPlayTime)`.

## Video / Camera Streaming (`1 FPS` JPEG)

Fetch JPEG snapshots from `GET http://<robot-bridge>:9000/camera/frame` (either continuously at `1 FPS` or on-demand when the tool `inspect_with_camera` is invoked) and stream to Gemini Live:

```typescript
session.sendRealtimeInput({
  video: { data: base64Jpeg, mimeType: 'image/jpeg' },
});
```

> **Vision Grounding Rule:** When switching to a visual inspection task, send the first camera frame **before or together with** the text prompt turn so Gemini has the image in context before generating its first spoken word.

## Embodied Tool Calling Pattern

Gemini Live emits `msg.toolCall.functionCalls` mid-stream while speaking. Execute the physical action on `robot-bridge` immediately (non-blocking movement coroutine on the robot) and return the `FunctionResponse` with the matching `fc.id`:

```typescript
if (msg.toolCall?.functionCalls?.length) {
  const responses = [];
  for (const fc of msg.toolCall.functionCalls) {
    // Mute mic for servo noise during physical gesture
    suppressMicForMs(1200);
    const result = await dispatchRobotTool(fc.name, fc.args);
    responses.push({
      id: fc.id,
      name: fc.name,
      response: { status: 'ok', ...result },
    });
  }
  session.sendToolResponse({ functionResponses: responses });
}
```

## Prompting Rules for Embodied Gemini Live Agents

1. **System prompts in English, output language pinned via `SpeechConfig.languageCode` (`es-US` or `en-US`).**
2. **Positive-only instructions:** Write `"Speak in 2 punchy sentences"`, `"Call express_verdict on every turn"`, instead of `"Do not give long answers"`.
3. **Physicality First:** Instruct the model to always pair its spoken reaction with `express_verdict` or `control_arm` at the start of its turn so the audience sees the robot react physically as it starts speaking.

## Common Mistakes

| Mistake | Fix |
|---|---|
| `responseModalities: [Modality.TEXT]` with voice | Use `[Modality.AUDIO]` + `outputAudioTranscription: {}` to get both voice and text |
| Omitting `languageCode` in `speechConfig` | Without `es-US`, Gemini switches regional accents between turns |
| Waiting for a 5-second servo animation before returning `sendToolResponse` | Fire the trajectory asynchronously in `robot-bridge` (`202 Accepted` + current telemetry) so Gemini keeps speaking while moving |
| Not flushing Web Audio scheduled buffers on `interrupted: true` | Keep an array of active `AudioBufferSourceNode`s and `.stop()` them all on barge-in |
| Hardcoding model names in code | Always read `NEXT_PUBLIC_GEMINI_LIVE_MODEL` / `GEMINI_MODEL` from env |
