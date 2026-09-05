/** Reject malformed protocol as an infrastructure error, never an honest empty match. */
export function parseOutcome(text, command) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || value.schema_version !== 1 || value.command !== command) return null;
  if (value.outcome === 'error') return value;
  if (command === 'graduate') {
    return ['synced', 'locked', 'partial', 'skipped'].includes(value.outcome) ? value : null;
  }
  const hits = (xs) => Array.isArray(xs) && xs.every(h => h && typeof h.id === 'string' && h.id &&
    typeof h.content === 'string' && Number.isFinite(h.distance) && h.distance >= 0 && h.distance <= 2);
  return value.outcome === 'ok' && hits(value.lessons) && hits(value.knowledge) ? value : null;
}
