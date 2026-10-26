import type { RobotActionResult } from './types';

/**
 * Tool response sent when the model calls a tool during a turn in which the app
 * already ran the physical action itself (text demos with untrusted GitHub data).
 * The prompt says "do NOT call any tool"; this enforces it in code.
 */
export const TOOL_DISABLED_RESPONSE = {
  status: 'error',
  code: 'tool_disabled',
  message: 'Tools are disabled for this turn: the app already executed the physical action. Nothing was executed.',
  hint: 'Do not call any tool in this turn and do not say that you moved. Just answer aloud in Spanish.',
} as const;

/**
 * Tracks "tool-free" turns. `begin()` is called right before sending a client
 * turn that must not trigger tools. The restriction lasts until the answer to
 * THAT turn ends: a `turnComplete`/`interrupted` only counts once the model
 * produced output for it (audio accepted by the gate or a tool call), so the
 * late `turnComplete` of the previous answer does not re-enable tools early.
 */
export class ToolFreeTurnGuard {
  private active = false;
  private sawOutput = false;

  begin(): void {
    this.active = true;
    this.sawOutput = false;
  }

  /** The model produced output that belongs to the current answer. */
  onModelOutput(): void {
    if (this.active) this.sawOutput = true;
  }

  /** `turnComplete` or `interrupted` from the server. */
  onTurnEnd(): void {
    if (this.active && this.sawOutput) this.reset();
  }

  /** New Live session: nothing pending. */
  reset(): void {
    this.active = false;
    this.sawOutput = false;
  }

  get toolsAllowed(): boolean {
    return !this.active;
  }
}

/** Hint for the model when a robot action fails (tool response `hint`). */
export function toolErrorHint(result: RobotActionResult): string | undefined {
  switch (result.code) {
    case 'estop_latched':
      return 'The emergency stop is engaged. Tell the audience in Spanish that the robot is in emergency stop until someone releases it. Do not retry any movement.';
    case 'unauthorized':
      return 'The robot bridge rejected the token. Say in Spanish that the robot is not authorized right now and continue without moving.';
    case 'braked':
      return 'The LiDAR safety brake cancelled the movement because of a nearby obstacle: the robot did NOT move. Do not say that you moved; briefly say in Spanish that the safety brake stopped you.';
    case 'lidar_stale':
      return 'The LiDAR has no recent data, so the bridge blocked the chassis: the robot did NOT move. Do not say that you moved; briefly say in Spanish that the LiDAR is not reporting and you stay still for safety.';
    case 'worker_dead':
      return 'The robot motion controller is not responding: nothing was executed. Do not say that you moved; briefly say in Spanish that the robot is not responding.';
    case 'blocked':
      return 'The robot bridge blocked the movement: the robot did NOT move. Do not say that you moved.';
    case 'timeout':
    case 'network':
      return 'The robot did not answer. Mention it briefly in Spanish and continue the conversation.';
    default:
      return undefined;
  }
}
