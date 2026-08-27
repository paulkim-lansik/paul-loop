// Hand-written declarations for the sibling .mjs. `hooks/` is plain ESM (it is loaded by the Claude
// Code hook runner, not bundled), but `test/untrusted-block.test.ts` imports it, so `tsc --noEmit`
// needs types for it. Enabling `allowJs` instead would pull every hook file into the typecheck —
// a much larger change than this module's two exports warrant.

/** One recalled string, made safe to place inside a delimiter: control chars → space, angle brackets
 * → lookalikes (U+2039/U+203A), whitespace collapsed, truncated to `max` characters. */
export function neutralize(s: unknown, max?: number): string

/** Wraps already-neutralized `body` in `<tag untrusted="true">` … `</tag>`. */
export function wrapUntrusted(tag: string, body: string): string
