---
name: gemini-live-js
description: Use when building real-time multimodal voice, vision, and embodied hardware agents in JavaScript/TypeScript with @google/genai Gemini Live API — WebSocket session lifecycle, 16kHz/24kHz Web Audio PCM streaming, barge-in interruption, tool calling for robotics, and Google Cloud Run deployment.
---

# Gemini Live API in JavaScript & TypeScript — Embodied AI Reference

## Overview

The Gemini Live API (`@google/genai`) provides stateful, low-latency bidirectional WebSocket streaming for audio, video, text, and non-blocking function calling. In an **Embodied AI** architecture, TypeScript orchestrates the multimodal stream in the browser (`Next.js 15`) while dispatching physical actuation tool calls to a local Rust/ROS 2 hardware bridge (`robot-bridge :9000`).

## Architecture: Cloud + Browser + Local Rust Bridge

```text
Browser (Next.js 15 / TS)                 Google Cloud                     ROSOrin Pro (Jetson Orin)
┌─────────────────────────────────┐      ┌──────────────────────────┐     ┌─────────────────────────────┐
│ Web Audio (16kHz in / 24kHz out)│◄────►│ Gemini Live API (WSS)    │     │ robot-bridge (Rust :9000)   │
│ @google/genai ai.live.connect   │      │ gemini-3.8-live          │     │ ├─ WS /ws (20Hz telemetry)  │
│                                 │      └──────────────────────────┘     │ ├─ POST /gesture (6-DOF+base)│
│ Embodied Tool Dispatcher ───────┼──────────────────────────────────────►│ ├─ POST /cmd_vel (watchdog) │
│   ├─ express_verdict()          │                                       │ ├─ POST /hud (/face display)│
│   ├─ release_deploy_key()       │                                       │ └─ GET /camera/frame (JPEG) │
│   ├─ point_at_service_totem()   │                                       └──────────────┬──────────────┘
│   ├─ move_chassis()             │                                                      ▼
│   └─ play_radio_sequence()      │                                       ROS 2 Humble / STM32 (/dev/rrc)
└─────────────────────────────────┘
```

## Session Setup (`@google/genai` TypeScript)

Never hardcode model IDs; read from `process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL` (default: `gemini-3.8-live`, see https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live). Note that in `gemini-3.8-live`, asynchronous function calling (`behavior: NON_BLOCKING`) is the default mode and `proactive_audio` is permanently enabled.

```typescript
import { GoogleGenAI, Modality, Type, type FunctionDeclaration } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: ephemeralOrApiKey, httpOptions: { apiVersion: 'v1alpha' } });
const model = process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL || 'gemini-3.8-live';

const session = await ai.live.connect({
  model,
  config: {
    responseModalities: [Modality.AUDIO], // MUST be AUDIO for voice
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT_EN }],
    },
    speechConfig: {
      languageCode: 'es-US', // Pin languageCode to prevent voice timbre drift
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: 'Kore' },
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    tools: [{ functionDeclarations: EMBODIED_TOOLS }],
  },
  callbacks: {
    onopen: () => onStatus('live'),
    onmessage: (msg) => handleServerMessage(msg),
    onerror: () => onStatus('rehearsal_voice'),
    onclose: () => onStatus('idle'),
  },
});
```

## Audio Pipeline in the Browser (16kHz Input / 24kHz Output)

1. **Microphone Input (16kHz, 16-bit PCM mono, base64):**
   - Capture via `AudioContext` + `AudioWorkletNode` (`attachPcmCaptureWorklet`).
   - Downsample `Float32Array` `[-1.0, 1.0]` to `16000 Hz` `Int16Array`, encode as base64, and send via:
     ```typescript
     session.sendRealtimeInput({
       audio: { data: base64Pcm16k, mimeType: 'audio/pcm;rate=16000' },
     });
     ```
2. **Echo & Servo Noise Suppression (`1,200 ms` Post-Servo Gate):**
   - **Layer 1 (Post-Servo Motion Suppression — `1,200 ms`):** Whenever any physical gesture, chassis movement, or Bumblebee dance is triggered (`this.motionSuppressUntil = Date.now() + 1200`), send zeroed PCM frames (`new Int16Array(outLen)`) for `1,200 ms`. Servos and Mecanum gears make mechanical noise that would otherwise trigger false VAD interruptions.
   - **Layer 2 (Speaker Playback Gate):** While the robot is speaking (`this.isPlayingAudio`), gate microphone audio unless `normalizedLevel > 0.36` (deliberate user barge-in).
   - **Layer 3 (Barge-In Queue Flush in `< 20 ms`):** When `msg.serverContent?.interrupted` is `true` or `normalizedLevel > 0.36`, `flushAudioQueueOnBargeIn()` immediately stops all active `AudioBufferSourceNode`s and resets `nextPlayTime = audioCtx.currentTime`.
3. **Gapless 24kHz PCM Playback:**
   - Decode incoming base64 16-bit PCM at `24000 Hz` into a `Float32Array`, copy into `audioCtx.createBuffer(1, samples.length, 24000)`, and schedule at `Math.max(audioCtx.currentTime + 0.02, nextPlayTime)`.

## Video / Camera Streaming (`1 FPS` JPEG)

Stream JPEG snapshots from the webcam or `GET http://<robot-bridge>:9000/camera/frame` to Gemini Live:

```typescript
await session.sendRealtimeInput({
  video: { data: jpegBase64, mimeType: 'image/jpeg' },
});
```

## Embodied Tool Declarations (`web/src/lib/gemini-live.ts` & `bumblebee-radio.ts`)

The codebase defines **4 physical tools** in `EMBODIED_TOOLS` (`web/src/lib/gemini-live.ts`) and **1 musical/dance tool** in `BUMBLEBEE_TOOLS` (`web/src/lib/bumblebee-radio.ts`):

1. **`express_verdict({ gesture, mood, verdict_headline })`** (Demo A `/demos/roaster`): Triggers 6-DOF arm and Mecanum choreographies (`facepalm`, `trash_toss`, `chef_kiss`, `suspicious_inspect`, `victory_spin`, `nod_yes`, `shake_no`, `wave_hello`, etc.) and updates `/hud`.
2. **`release_deploy_key({ decision: "approve" | "reject", reason_es })`** (Demo B `/demos/gatekeeper`): Rotates `joint1` to the green tray (`680`) or red tray (`260`) and opens Gripper Servo ID 10 (`680 -> 220`) to drop the physical Production Deploy Key.
3. **`point_at_service_totem({ service: "cloud_run" | "gemini_live" | "firestore", diagnosis_es })`** (Demo C `/demos/bughunter`): Strafes the Mecanum chassis laterally (`Y = ±20 cm`) and points the 6-DOF arm at the culpable service totem.
4. **`move_chassis({ direction, duration_ms })`** (All demos): Drives the Mecanum omnidirectional chassis (`forward`, `backward`, `strafe_left`, `strafe_right`, `spin_left`, `spin_right`) protected by the `600 ms` watchdog and `< 0.28 m` LiDAR brake.
5. **`play_radio_sequence({ clip_ids, dance_gesture, radio_caption })`** (Demo D `/demos/bumblebee`): Plays FM static sweep + song clips from the 168-clip catalog (`95 ES / 73 EN`) + `bumblebee_*` dance choreography.

```typescript
if (msg.toolCall?.functionCalls?.length) {
  const responses = [];
  for (const fc of msg.toolCall.functionCalls) {
    // Mute mic for 1,200 ms to suppress servo gear noise
    this.motionSuppressUntil = Date.now() + 1200;
    const res = await this.executeEmbodiedTool(fc.name, fc.args || {});
    responses.push({
      id: fc.id,
      name: fc.name,
      response: { status: 'ok', ...res },
    });
  }
  await session.sendToolResponse({ functionResponses: responses });
}
```

## Common Mistakes

| Mistake | Fix |
|---|---|
| `responseModalities: [Modality.TEXT]` with voice | Use `[Modality.AUDIO]` + `outputAudioTranscription: {}` to get both voice and text |
| Omitting `languageCode` in `speechConfig` | Without `es-US`, Gemini switches regional accents between turns |
| Using deprecated `media:` wrapper in `sendRealtimeInput` | Pass `{ audio: { data, mimeType: 'audio/pcm;rate=16000' } }` or `{ video: { data, mimeType: 'image/jpeg' } }` |
| Not muting mic during servo movement | Set a `1,200 ms` post-servo acoustic suppression window (`motionSuppressUntil = Date.now() + 1200`) |
| Not flushing Web Audio scheduled buffers on `interrupted: true` | Keep an array of active `AudioBufferSourceNode`s and `.stop()` them all on barge-in |
