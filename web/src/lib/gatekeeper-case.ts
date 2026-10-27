/**
 * Demo B: what to do with the deploy key when the presenter switches to another PR case.
 * In the mock bridge or the twin-only simulation the key can go straight back to the gripper;
 * with the real robot the physical key cannot teleport, so we only ask for it.
 */
export type CaseSwitchAction = 'hold' | 'hint' | 'none';

export const PUT_KEY_BACK_HINT = 'Vuelve a poner la llave en la pinza y pulsa Sujetar Llave.';

export function caseSwitchAction(
  bridgeConnected: boolean,
  backend: string | undefined,
  heldObject: string | undefined
): CaseSwitchAction {
  const simulated = !bridgeConnected || backend === 'mock';
  if (simulated) return 'hold';
  return heldObject && heldObject !== 'deploy_key' ? 'hint' : 'none';
}
