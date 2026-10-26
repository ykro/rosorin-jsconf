/**
 * Gapless playback of Gemini Live 24 kHz PCM16 chunks.
 * Sources are pruned on `ended`, and `close()` releases the AudioContext.
 */
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextPlayTime = 0;
  private playing = false;
  private readonly onPlayingChange: (playing: boolean) => void;

  constructor(onPlayingChange: (playing: boolean) => void) {
    this.onPlayingChange = onPlayingChange;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Must run inside a user gesture at least once so autoplay policies allow audio. */
  unlock() {
    if (typeof window === 'undefined') return;
    try {
      if (!this.ctx) this.ctx = new AudioContext({ sampleRate: 24000 });
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch((err) => console.warn('[audio] resume falló:', err));
      }
    } catch (err) {
      console.warn('[audio] No se pudo crear el AudioContext de reproducción:', err);
    }
  }

  playBase64Pcm16(base64Data: string) {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    if (!float32.length) return;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime + 0.02, this.nextPlayTime);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.setPlaying(false);
    };
    this.sources.add(source);
    this.setPlaying(true);
    source.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;
  }

  /** Stops everything queued (barge-in). */
  flush() {
    for (const src of this.sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    if (this.ctx) this.nextPlayTime = this.ctx.currentTime;
    this.setPlaying(false);
  }

  close() {
    this.flush();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      ctx.close().catch((err) => console.warn('[audio] close falló:', err));
    }
    this.nextPlayTime = 0;
  }

  private setPlaying(next: boolean) {
    if (this.playing === next) return;
    this.playing = next;
    this.onPlayingChange(next);
  }
}
