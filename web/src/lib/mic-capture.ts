import { attachPcmCaptureWorklet, type PcmWorkletFrame } from './audio-worklet';

export type MicStartResult = 'ok' | 'unsupported' | 'denied' | 'cancelled';

/**
 * Owns the microphone stream, its AudioContext and the capture worklet.
 * `start()` never opens a second stream on top of a live one, and `stop()` is
 * idempotent and safe to call while `start()` is still awaiting permissions.
 */
export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private detachWorklet: (() => void) | null = null;
  private startToken = 0;

  get active(): boolean {
    return this.stream !== null;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  async start(onFrame: (frame: PcmWorkletFrame, sampleRate: number) => void): Promise<MicStartResult> {
    if (this.stream) {
      if (this.ctx?.state === 'suspended') {
        await this.ctx.resume().catch((err) => console.warn('[mic] resume falló:', err));
      }
      return 'ok';
    }
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return 'unsupported';
    }
    const token = ++this.startToken;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      console.warn('[mic] getUserMedia rechazado:', err);
      return 'denied';
    }
    const settings = stream.getAudioTracks()[0]?.getSettings?.();
    if (settings) {
      // The browser may ignore a constraint: log what it actually applied (echo cancellation matters
      // most, the speakers play the robot's songs next to this mic).
      console.info(
        `[mic] echoCancellation=${settings.echoCancellation} noiseSuppression=${settings.noiseSuppression} autoGainControl=${settings.autoGainControl}`
      );
    }
    if (token !== this.startToken || this.stream) {
      // stop() was called (or another start won) while waiting for permission.
      stream.getTracks().forEach((t) => t.stop());
      return this.stream ? 'ok' : 'cancelled';
    }

    const ctx = new AudioContext();
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      const { disconnect } = await attachPcmCaptureWorklet(ctx, stream, (frame) =>
        onFrame(frame, ctx.sampleRate)
      );
      if (token !== this.startToken) {
        disconnect();
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch((err) => console.warn('[mic] close falló:', err));
        return 'cancelled';
      }
      this.stream = stream;
      this.ctx = ctx;
      this.detachWorklet = disconnect;
      return 'ok';
    } catch (err) {
      console.warn('[mic] No se pudo iniciar el AudioWorklet de captura:', err);
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch((closeErr) => console.warn('[mic] close falló:', closeErr));
      return 'denied';
    }
  }

  stop() {
    this.startToken += 1;
    if (this.detachWorklet) {
      this.detachWorklet();
      this.detachWorklet = null;
    }
    if (this.ctx) {
      this.ctx.close().catch((err) => console.warn('[mic] close falló:', err));
      this.ctx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
