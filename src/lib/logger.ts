/**
 * Redaction-aware logger helpers. Anything containing a mnemonic, private key,
 * or raw signed payload must go through `redact()` before being logged.
 */
const SENSITIVE_KEYS = [
  'mnemonic',
  'master_mnemonic',
  'MASTER_MNEMONIC',
  'privateKey',
  'private_key',
  'signature',
  'signed_payload',
  'signedPayload',
  'password',
  'passwordHash',
  'JWT_SECRET',
];

export function redact<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return (obj as unknown[]).map((v) => (typeof v === 'object' && v !== null ? redact(v) : v)) as unknown as T;
  }
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
      out[k] = '[REDACTED]';
    } else if (typeof out[k] === 'object' && out[k] !== null) {
      out[k] = redact(out[k]);
    }
  }
  return out as T;
}
