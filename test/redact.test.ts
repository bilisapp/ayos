import { describe, expect, it } from "vitest";
import { REDACTED, makeRedactor } from "../src/events/redact.ts";

const CLONE_TOKEN = "ghs_AbCdEf0123456789AbCdEf0123456789";
const LLM_KEY = "sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

describe("literal secrets from the job spec", () => {
  const { redactString, redactValue } = makeRedactor([CLONE_TOKEN, LLM_KEY]);

  it("scrubs both literals from a plain string", () => {
    const out = redactString(`clone with ${CLONE_TOKEN} and call with ${LLM_KEY}`);
    expect(out).toBe(`clone with ${REDACTED} and call with ${REDACTED}`);
    expect(out).not.toContain(CLONE_TOKEN);
    expect(out).not.toContain(LLM_KEY);
  });

  it("scrubs every occurrence, not just the first", () => {
    const out = redactString(`${CLONE_TOKEN} ${CLONE_TOKEN} ${CLONE_TOKEN}`);
    expect(out).toBe(`${REDACTED} ${REDACTED} ${REDACTED}`);
  });

  it("scrubs secrets embedded mid-token (e.g. inside a URL)", () => {
    const out = redactString(`https://x-access-token:${CLONE_TOKEN}@github.com/org/app.git`);
    expect(out).not.toContain(CLONE_TOKEN);
    expect(out).toContain("github.com/org/app.git");
  });

  it("scrubs through nested objects and arrays", () => {
    const event = {
      type: "tool_result",
      data: {
        stdout: `fatal: auth for ${CLONE_TOKEN}`,
        env: [{ name: "ANTHROPIC_API_KEY", value: LLM_KEY }],
        nested: { deep: { deeper: [[`${LLM_KEY}`]] } },
      },
    };
    const out = redactValue(event) as typeof event;
    expect(JSON.stringify(out)).not.toContain(CLONE_TOKEN);
    expect(JSON.stringify(out)).not.toContain(LLM_KEY);
    expect(out.data.stdout).toBe(`fatal: auth for ${REDACTED}`);
    expect(out.data.env[0]!.value).toBe(REDACTED);
    expect(out.data.nested.deep.deeper[0]![0]).toBe(REDACTED);
  });

  it("scrubs object KEYS, not just values", () => {
    const out = redactValue({ [`token-${CLONE_TOKEN}`]: "irrelevant" }) as Record<string, unknown>;
    const keys = Object.keys(out);
    expect(keys).toEqual([`token-${REDACTED}`]);
    expect(JSON.stringify(out)).not.toContain(CLONE_TOKEN);
  });

  it("does not mutate the input object", () => {
    const input = { a: { b: CLONE_TOKEN } };
    const out = redactValue(input) as typeof input;
    expect(input.a.b).toBe(CLONE_TOKEN);
    expect(out.a.b).toBe(REDACTED);
    expect(out).not.toBe(input);
  });

  it("masks the longest literal whole when one token contains another", () => {
    const outer = "ghs_LONGTOKEN_containing_inner_1234567890";
    const inner = "containing_inner";
    const r = makeRedactor([inner, outer]);
    expect(r.redactString(outer)).toBe(REDACTED);
  });
});

describe("short literals are ignored", () => {
  it("does not scrub literals under 8 chars (would mangle everything)", () => {
    const { redactString } = makeRedactor(["main", "a", "abcdefg", ""]);
    expect(redactString("checkout main at abcdefg — a fine commit")).toBe(
      "checkout main at abcdefg — a fine commit",
    );
  });

  it("does scrub an 8-char literal (boundary)", () => {
    const { redactString } = makeRedactor(["abcdefgh"]);
    expect(redactString("x abcdefgh y")).toBe(`x ${REDACTED} y`);
  });

  it("tolerates null/undefined entries in the literal list", () => {
    const { redactString } = makeRedactor([null, undefined, CLONE_TOKEN]);
    expect(redactString(CLONE_TOKEN)).toBe(REDACTED);
  });
});

describe("pattern-based scrubbing (secrets never passed as literals)", () => {
  const { redactString, redactValue } = makeRedactor(); // no literals at all

  it("scrubs a ghs_ GitHub token", () => {
    const stray = "ghs_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    expect(redactString(`leaked ${stray} oops`)).toBe(`leaked ${REDACTED} oops`);
  });

  it("scrubs other GitHub token prefixes", () => {
    for (const t of [
      "ghp_0123456789abcdefghij0123456789abcdef",
      "gho_0123456789abcdefghij0123456789abcdef",
      "ghu_0123456789abcdefghij0123456789abcdef",
      "ghr_0123456789abcdefghij0123456789abcdef",
    ]) {
      expect(redactString(t), t).toBe(REDACTED);
    }
  });

  it("scrubs an sk-ant- Anthropic key", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-0123456789";
    expect(redactString(`ANTHROPIC_API_KEY=${key}`)).toBe(`ANTHROPIC_API_KEY=${REDACTED}`);
  });

  it("scrubs an AWS access key id", () => {
    expect(redactString("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED);
  });

  it("scrubs a JWT-shaped string", () => {
    const jwt =
      "eyJhbGciOiJFZERTQSJ9.eyJqb2IiOiIxMjMiLCJzY29wZSI6InN0cmVhbTpyZWFkIn0.c2lnbmF0dXJlLWJ5dGVz";
    expect(redactString(`Authorization: Bearer ${jwt}`)).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it("scrubs patterns nested in objects and in keys", () => {
    const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciJ9.QUJDREVGR0hJSktM";
    const out = redactValue({ headers: { [`auth-${jwt}`]: `Bearer ${jwt}` } });
    expect(JSON.stringify(out)).not.toContain("eyJ");
  });

  it("leaves ordinary text that merely looks tokenish alone", () => {
    const text = "ghs_short and sk-ant- and eyJ and AKIA plus app/Services/Foo.php";
    expect(redactString(text)).toBe(text);
  });
});

describe("regex-special characters in literals", () => {
  it("treats a literal token as literal text, not a pattern", () => {
    const weird = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
    const { redactString } = makeRedactor([weird]);
    expect(redactString(`before ${weird} after`)).toBe(`before ${REDACTED} after`);
  });

  it("does not let a '.*'-containing literal swallow unrelated text", () => {
    const { redactString } = makeRedactor(["secret.*value"]);
    expect(redactString("secretXXXvalue stays")).toBe("secretXXXvalue stays");
    expect(redactString("secret.*value goes")).toBe(`${REDACTED} goes`);
  });

  it("a literal of only metacharacters cannot match everything", () => {
    const { redactString } = makeRedactor([".*.*.*.*"]);
    expect(redactString("perfectly ordinary log line")).toBe("perfectly ordinary log line");
  });
});

describe("non-string values", () => {
  const { redactValue } = makeRedactor([CLONE_TOKEN]);

  it("passes numbers, booleans, null and undefined through untouched", () => {
    const input = { n: 42, f: 1.5, t: true, f2: false, nul: null, u: undefined };
    expect(redactValue(input)).toEqual(input);
  });

  it("returns primitives unchanged at the top level", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBe(null);
    expect(redactValue(undefined)).toBe(undefined);
    expect(redactValue(true)).toBe(true);
  });

  it("preserves array shape and length", () => {
    const out = redactValue([1, CLONE_TOKEN, null, [2, CLONE_TOKEN]]) as unknown[];
    expect(out).toEqual([1, REDACTED, null, [2, REDACTED]]);
  });

  it("stops recursing at a depth cap instead of blowing the stack", () => {
    let deep: Record<string, unknown> = { leaf: CLONE_TOKEN };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    expect(() => redactValue(deep)).not.toThrow();
  });
});
