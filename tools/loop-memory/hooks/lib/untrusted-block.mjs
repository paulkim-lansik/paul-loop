// Wraps recalled text so an agent reads it as *data*, and so that nothing inside it can stop being
// data. Extracted from recall-lessons.mjs to give the property below a test seam — it had none, which
// is how the hole below survived.
//
// The property, stated as an invariant rather than a filter list:
//
//   **The delimiter is unforgeable.** `<` and `>` cannot occur in wrapped content, therefore no
//   sequence a note contains can close the block early.
//
// What that replaces: the original stripped control characters only, leaving `<`, `>` and `/` intact.
// A stored note could then emit `</past-lessons>`, continue with anything it liked *outside* the
// untrusted marking, and re-open a tag so the block still looked well-formed. Up to 6 hits × 300
// chars per turn of attacker-chosen text, presented as ordinary context.
//
// Why not escape the specific closing string: that loses to case changes, whitespace inside the tag,
// and the next delimiter someone adds. Neutralising the two characters the delimiter is built from
// cannot lose to any of those.
//
// Why lookalikes instead of deletion: the text stays readable. A lesson mentioning `<Component>`
// still reads as one. This is reference data already truncated to 300 characters — exact fidelity is
// not what it is for.

/** U+2039/U+203A single guillemets — visually close to angle brackets, and not the delimiter. */
const LT = '‹';
const GT = '›';

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char stripping
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** One recalled string, made safe to place inside a delimiter. Control chars → space (newlines
 * included, so a hit cannot span lines), angle brackets → lookalikes, whitespace collapsed, capped. */
export function neutralize(s, max = 300) {
  return String(s)
    .replace(CONTROL, ' ')
    .replace(/</g, LT)
    .replace(/>/g, GT)
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

/** `<tag untrusted="true">` … `</tag>` around already-neutralized lines. Kept next to `neutralize` so
 * the two cannot drift apart — the wrapper's safety is entirely a property of what went through it. */
export function wrapUntrusted(tag, body) {
  return `<${tag} untrusted="true">\n${body}\n</${tag}>`;
}
