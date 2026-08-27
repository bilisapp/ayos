import { describe, expect, it } from "vitest";
import {
  MAX_SKEW_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
  verify,
} from "../src/auth/hmac.ts";

const SECRET = "s3cret-shared-between-caller-and-ayos";
const BODY = JSON.stringify({ job_id: "abc", repo: "org/app" });
const TS = "2026-08-27T12:00:00.000Z";
const NOW = Date.parse(TS);

function headersFrom(h: Record<string, string>) {
  return { signature: h[SIGNATURE_HEADER], timestamp: h[TIMESTAMP_HEADER] };
}

describe("sign", () => {
  it("emits the spec's header names and sha256= prefix", () => {
    const h = sign(SECRET, BODY, TS);
    expect(Object.keys(h).sort()).toEqual([SIGNATURE_HEADER, TIMESTAMP_HEADER].sort());
    expect(h[TIMESTAMP_HEADER]).toBe(TS);
    expect(h[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("defaults the timestamp to now when not supplied", () => {
    const h = sign(SECRET, BODY);
    const drift = Math.abs(Date.now() - Date.parse(h[TIMESTAMP_HEADER]!));
    expect(drift).toBeLessThan(5000);
    expect(verify(SECRET, BODY, headersFrom(h))).toEqual({ ok: true });
  });

  it("binds the timestamp into the mac (same body, different ts → different sig)", () => {
    const a = sign(SECRET, BODY, TS);
    const b = sign(SECRET, BODY, "2026-08-27T12:00:01.000Z");
    expect(a[SIGNATURE_HEADER]).not.toBe(b[SIGNATURE_HEADER]);
  });
});

describe("verify", () => {
  it("round-trips a freshly signed body", () => {
    expect(verify(SECRET, BODY, headersFrom(sign(SECRET, BODY, TS)), NOW)).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const h = sign(SECRET, BODY, TS);
    const res = verify(SECRET, BODY.replace("org/app", "org/evil"), headersFrom(h), NOW);
    expect(res).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a body with an appended byte", () => {
    const h = sign(SECRET, BODY, TS);
    expect(verify(SECRET, `${BODY} `, headersFrom(h), NOW).ok).toBe(false);
  });

  it("rejects a tampered timestamp (replay of a captured signature)", () => {
    const h = sign(SECRET, BODY, TS);
    const moved = "2026-08-27T12:01:00.000Z";
    const res = verify(SECRET, BODY, { signature: h[SIGNATURE_HEADER], timestamp: moved }, NOW);
    expect(res).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a signature made with a different secret", () => {
    const h = sign("other-secret-entirely", BODY, TS);
    expect(verify(SECRET, BODY, headersFrom(h), NOW)).toEqual({
      ok: false,
      reason: "signature mismatch",
    });
  });

  it("accepts timestamps at the edges of the ±5 min window", () => {
    const h = sign(SECRET, BODY, TS);
    expect(verify(SECRET, BODY, headersFrom(h), NOW + MAX_SKEW_MS).ok).toBe(true);
    expect(verify(SECRET, BODY, headersFrom(h), NOW - MAX_SKEW_MS).ok).toBe(true);
  });

  it("rejects a timestamp too far in the past", () => {
    const h = sign(SECRET, BODY, TS);
    expect(verify(SECRET, BODY, headersFrom(h), NOW + MAX_SKEW_MS + 1)).toEqual({
      ok: false,
      reason: "timestamp outside window",
    });
  });

  it("rejects a timestamp too far in the future", () => {
    const h = sign(SECRET, BODY, TS);
    expect(verify(SECRET, BODY, headersFrom(h), NOW - MAX_SKEW_MS - 1)).toEqual({
      ok: false,
      reason: "timestamp outside window",
    });
  });

  it("checks the window before the mac, so a stale-but-valid signature still fails", () => {
    const h = sign(SECRET, BODY, TS);
    const res = verify(SECRET, BODY, headersFrom(h), NOW + 60 * 60 * 1000);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("timestamp outside window");
  });

  it("reports missing headers distinctly", () => {
    const h = sign(SECRET, BODY, TS);
    expect(verify(SECRET, BODY, { timestamp: TS }, NOW)).toEqual({
      ok: false,
      reason: "missing signature",
    });
    expect(verify(SECRET, BODY, { signature: h[SIGNATURE_HEADER] }, NOW)).toEqual({
      ok: false,
      reason: "missing timestamp",
    });
    expect(verify(SECRET, BODY, { signature: null, timestamp: null }, NOW).ok).toBe(false);
    expect(verify(SECRET, BODY, {}, NOW).ok).toBe(false);
  });

  it("rejects a malformed timestamp without throwing", () => {
    const h = sign(SECRET, BODY, TS);
    expect(verify(SECRET, BODY, { signature: h[SIGNATURE_HEADER], timestamp: "yesterday" }, NOW))
      .toEqual({ ok: false, reason: "malformed timestamp" });
  });

  it("rejects a malformed signature header", () => {
    for (const signature of ["deadbeef", "sha1=deadbeef", "sha256=", "=abc", ""]) {
      const res = verify(SECRET, BODY, { signature, timestamp: TS }, NOW);
      expect(res.ok, signature).toBe(false);
    }
  });

  it("does not throw on signatures of the wrong length or non-hex content", () => {
    const cases = [
      "sha256=00",
      "sha256=" + "0".repeat(63),
      "sha256=" + "0".repeat(65),
      "sha256=" + "0".repeat(200),
      "sha256=zzzzzzzz",
      "sha256=not-hex-at-all!!",
      "sha256=" + "ß".repeat(64),
    ];
    for (const signature of cases) {
      let res: ReturnType<typeof verify> | undefined;
      expect(() => {
        res = verify(SECRET, BODY, { signature, timestamp: TS }, NOW);
      }, signature).not.toThrow();
      expect(res!.ok, signature).toBe(false);
    }
  });

  it("verifies an empty body", () => {
    const h = sign(SECRET, "", TS);
    expect(verify(SECRET, "", headersFrom(h), NOW).ok).toBe(true);
    expect(verify(SECRET, "x", headersFrom(h), NOW).ok).toBe(false);
  });
});
