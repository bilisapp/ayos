/**
 * Secret scrubbing. Runs on every event before it is buffered, streamed, or
 * shipped in an artifact — the last line of defence if an agent echoes a token.
 */
const PATTERNS: RegExp[] = [
  /ghs_[A-Za-z0-9_]{16,}/g,
  /gh[pousr]_[A-Za-z0-9_]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export const REDACTED = "[redacted]";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Literal secrets from the job spec, plus the generic patterns above. */
export function makeRedactor(literals: readonly (string | null | undefined)[] = []) {
  const lits = literals
    .filter((s): s is string => typeof s === "string" && s.length >= 8)
    // longest first, so a token that contains another is masked whole
    .sort((a, b) => b.length - a.length)
    .map((s) => new RegExp(escapeRe(s), "g"));

  const redactString = (input: string): string => {
    let out = input;
    for (const re of lits) out = out.replace(re, REDACTED);
    for (const re of PATTERNS) out = out.replace(re, REDACTED);
    return out;
  };

  const redactValue = (value: unknown, depth = 0): unknown => {
    if (depth > 12) return value;
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[redactString(k)] = redactValue(v, depth + 1);
      }
      return out;
    }
    return value;
  };

  return { redactString, redactValue };
}

export type Redactor = ReturnType<typeof makeRedactor>;
