/**
 * Single-key stage shortcuts must not fire while the user types or uses
 * browser/OS shortcuts (Cmd/Ctrl+R used to move joint 4). WCAG 2.1.4.
 */
export function shouldIgnoreShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) {
    return true;
  }
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    Boolean(target.closest?.('[role="dialog"]'))
  );
}
