export interface PcmWorkletFrame {
  samples: Float32Array;
  rms: number;
  sampleRate: number;
}

export function downsampleFloat32ToInt16_16kHz(
  input: Float32Array,
  inputSampleRate: number
): Int16Array {
  if (inputSampleRate === 16000) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputSampleRate / 16000;
  const outLength = Math.round(input.length / ratio);
  const out = new Int16Array(outLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < out.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    const avg = count > 0 ? accum / count : 0;
    const s = Math.max(-1, Math.min(1, avg));
    out[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7fff;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return out;
}

export function int16ToBase64(pcm16: Int16Array): string {
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function attachPcmCaptureWorklet(
  micCtx: AudioContext,
  stream: MediaStream,
  onFrame: (frame: PcmWorkletFrame) => void
): Promise<{
  workletNode: AudioWorkletNode;
  disconnect: () => void;
}> {
  await micCtx.audioWorklet.addModule('/pcm-capture-worklet.js');
  const source = micCtx.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(micCtx, 'pcm-capture-worklet');
  const silentGain = micCtx.createGain();
  silentGain.gain.value = 0;

  workletNode.port.onmessage = (ev: MessageEvent<PcmWorkletFrame>) => {
    if (ev.data && ev.data.samples) {
      onFrame(ev.data);
    }
  };

  source.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(micCtx.destination);

  return {
    workletNode,
    disconnect: () => {
      try {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
        source.disconnect();
        silentGain.disconnect();
      } catch {
        // ignore
      }
    },
  };
}
