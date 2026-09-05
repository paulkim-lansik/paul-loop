// Always on for persisted/external memory. This is minimization, not a general PII classifier.
// Arbitrary confidential prose cannot be detected mechanically; sensitive projects must disable recall.
export function sanitizeMemory(value, max = 16000) {
  return String(value ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE-KEY-REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[\w-]{35}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[\w-]{10,})\b/g, '[SECRET-REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[AUTH-REDACTED]')
    .replace(/(["']?[\w.-]*(?:token|secret|password|passwd|api[-_]?key|authorization|cookie)[\w.-]*["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (raw) => {
      try { const u = new URL(raw); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
      catch { return '[URL-REDACTED]'; }
    })
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL-REDACTED]')
    .replace(/\b\d{6}-[1-8]\d{6}\b/g, '[ID-REDACTED]')
    .replace(/(?<!\w)(?:\+\d{1,3}[- .]?)?(?:0\d{1,2}|\(\d{3}\))[- .]\d{3,4}[- .]\d{4}(?!\w)/g, '[PHONE-REDACTED]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[NUMBER-REDACTED]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, max);
}
