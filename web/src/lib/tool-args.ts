/**
 * Client-side clamping of tool / bridge parameters. The Rust bridge clamps
 * again (defense in depth), but arguments produced by the model are untrusted
 * and must never reach the robot outside these ranges.
 */

/** Same limits as robot-bridge/src/protocol.rs (MAX_LINEAR_MPS, MAX_ANGULAR_RAD_S). */
export const MAX_LINEAR_MPS = 0.25;
export const MAX_ANGULAR_RAD_S = 0.8;

/** `move_chassis` tool: duration declared to the model as 300..1500 ms. */
export const CHASSIS_DURATION_MIN_MS = 300;
export const CHASSIS_DURATION_MAX_MS = 1500;
export const CHASSIS_DURATION_DEFAULT_MS = 550;

/** `/arm` duration accepted by the bridge (encode_bus_servos clamps to 120..=5000). */
export const ARM_DURATION_MIN_MS = 120;
export const ARM_DURATION_MAX_MS = 5000;

export const MAX_TOOL_TEXT_CHARS = 240;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clampChassisDurationMs(value: unknown): number {
  return Math.round(
    clamp(finiteOr(value, CHASSIS_DURATION_DEFAULT_MS), CHASSIS_DURATION_MIN_MS, CHASSIS_DURATION_MAX_MS)
  );
}

export function clampArmDurationMs(value: unknown): number {
  return Math.round(clamp(finiteOr(value, 400), ARM_DURATION_MIN_MS, ARM_DURATION_MAX_MS));
}

export function clampChassisVelocity(
  linear_x: unknown,
  linear_y: unknown,
  angular_z: unknown
): { linear_x: number; linear_y: number; angular_z: number } {
  return {
    linear_x: clamp(finiteOr(linear_x, 0), -MAX_LINEAR_MPS, MAX_LINEAR_MPS),
    linear_y: clamp(finiteOr(linear_y, 0), -MAX_LINEAR_MPS, MAX_LINEAR_MPS),
    angular_z: clamp(finiteOr(angular_z, 0), -MAX_ANGULAR_RAD_S, MAX_ANGULAR_RAD_S),
  };
}

/** Returns `value` if it is one of `allowed`, otherwise null (never forwards unknown enum values). */
export function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** Plain, short, single-line text for HUD/headlines coming from the model. */
export function cleanToolText(value: unknown, maxChars = MAX_TOOL_TEXT_CHARS): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** At most `max` unique string ids. */
export function cleanIdList(value: unknown, max = 3): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v.slice(0, 80));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Wraps untrusted external text (GitHub repos, PRs, issues) in a delimited block
 * the system prompt tells the model to treat as data only.
 *
 * Every angle bracket inside the data is escaped (NFKC folds look-alikes such
 * as `＜` or `﹤` into `<`; `‹`, `⟨`, `〈`… are escaped as well), so no variant of a closing tag (`< /repo_data>`,
 * `</repo_data foo>`, `</repo-data>`, `＜/repo_data＞`…) can end the block early.
 */
export function wrapUntrusted(tag: string, text: string, maxChars = 1500): string {
  const safe = text
    .normalize('NFKC')
    .replace(/&/g, '&amp;')
    .replace(/[<\u2039\u27E8\u3008\u276C\u276E\u02C2]/g, '&lt;')
    .replace(/[>\u203A\u27E9\u3009\u276D\u276F\u02C3]/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  return `<${tag}>\n${safe}\n</${tag}>`;
}
