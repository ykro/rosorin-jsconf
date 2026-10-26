/**
 * Decides whether an incoming Gemini Live audio chunk should be played after a
 * barge-in. Each model response is a "generation"; an interruption discards
 * only the generation that is still streaming from the server, never the next
 * one.
 *
 * Without this, a local barge-in after the server already sent `turnComplete`
 * (audio still playing from the local queue) would mark the *next* response as
 * discarded and the robot would go mute.
 *
 * A client turn (text demo, typed message) sent while the server is still
 * streaming discards the tail of that answer. The new answer starts a new
 * generation on the first end marker of the old one (`interrupted`,
 * `generationComplete` or `turnComplete`); if the server sends none of them,
 * chunks are accepted again after `CLIENT_TURN_GRACE_MS` so the robot can never
 * stay mute for a whole answer.
 */
export const CLIENT_TURN_GRACE_MS = 1200;

export class TurnAudioGate {
  private generation = 0;
  private discardedGeneration = -1;
  private serverStreaming = false;
  /** When a client turn was sent while discarding the previous generation (null: none pending). */
  private clientTurnAt: number | null = null;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Call for every audio chunk received; returns whether to enqueue it for playback. */
  acceptAudioChunk(): boolean {
    if (
      this.isDiscardingCurrent &&
      this.clientTurnAt !== null &&
      this.now() - this.clientTurnAt >= CLIENT_TURN_GRACE_MS
    ) {
      // No end marker for the discarded answer: this must be the new one.
      this.advance();
    }
    this.serverStreaming = true;
    return !this.isDiscardingCurrent;
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

  /**
   * A client turn was just sent (after `interrupt()`). Its answer must play even
   * if the server never closes the discarded generation explicitly.
   */
  beginClientTurn(): void {
    this.clientTurnAt = this.isDiscardingCurrent ? this.now() : null;
  }

  /** `serverContent.interrupted`: the server stopped this generation. */
  onServerInterrupted(): void {
    this.advance();
  }

  /** `serverContent.generationComplete`: the model sent all of this generation's audio. */
  onGenerationComplete(): void {
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
    this.clientTurnAt = null;
  }
}
