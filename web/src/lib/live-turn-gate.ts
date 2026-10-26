/**
 * Decides whether an incoming Gemini Live audio chunk should be played after a
 * barge-in. Each model response is a "generation"; an interruption discards
 * only the generation that is still streaming from the server, never the next
 * one.
 *
 * Without this, a local barge-in after the server already sent `turnComplete`
 * (audio still playing from the local queue) would mark the *next* response as
 * discarded and the robot would go mute.
 */
export class TurnAudioGate {
  private generation = 0;
  private discardedGeneration = -1;
  private serverStreaming = false;

  /** Call for every audio chunk received; returns whether to enqueue it for playback. */
  acceptAudioChunk(): boolean {
    this.serverStreaming = true;
    return this.generation !== this.discardedGeneration;
  }

  /**
   * The user interrupted (voice barge-in or the "Interrumpir" button).
   * If the server is still streaming this generation, drop the rest of it.
   * If it already finished, there is nothing left to discard server-side:
   * the caller only flushes the local playback queue.
   */
  interrupt(): void {
    if (this.serverStreaming) this.discardedGeneration = this.generation;
  }

  /** `serverContent.interrupted`: the server stopped this generation. */
  onServerInterrupted(): void {
    this.advance();
  }

  /** `serverContent.turnComplete`: this generation is over. */
  onTurnComplete(): void {
    this.advance();
  }

  /** New session (connect / reconnect): forget everything. */
  reset(): void {
    this.advance();
  }

  get isDiscardingCurrent(): boolean {
    return this.generation === this.discardedGeneration;
  }

  private advance() {
    this.generation += 1;
    this.serverStreaming = false;
  }
}
