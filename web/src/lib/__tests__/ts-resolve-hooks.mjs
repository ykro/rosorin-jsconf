/**
 * Test-only resolve hook: the app imports sibling modules without an extension
 * (`./robot-client`, bundler style), which Node's ESM loader does not resolve.
 * Retry those relative specifiers with `.ts` so tests can import real modules.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && relative && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
