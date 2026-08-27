import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import type { Config } from "../src/config.ts";
import type { JobHost, JobSnapshot } from "../src/job/host.ts";
import type { Artifact } from "../src/types.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "../src/auth/hmac.ts";

const SECRET = "shared-secret";

/** Enough of a host to answer the control-plane routes. */
function fakeHost(): JobHost {
  const snapshot = (job_id: string): JobSnapshot => ({
    job_id,
    state: "done",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  return {
    async start(spec) {
      return { snapshot: snapshot(spec.job_id), created: true };
    },
    async get() {
      return null;
    },
    async cancel() {
      return true;
    },
    async artifact(jobId) {
      return { job_id: jobId } as unknown as Artifact;
    },
    async subscribe() {
      return null;
    },
    async activeCount() {
      return 0;
    },
  };
}

function app(overrides: Partial<Config> = {}) {
  const config: Config = {
    port: 0,
    sharedSecret: SECRET,
    streamJwtPublicKey: null,
    allowedOrigin: "",
    maxConcurrentJobs: 4,
    defaultTimeoutS: 900,
    maxBodyBytes: 1024,
    hmacMode: "compat",
    ...overrides,
  };
  return createApp({ config, host: fakeHost() });
}

const bound = (method: string, path: string, body: string) =>
  sign(SECRET, body, undefined, { method, path });

describe("control-plane auth", () => {
  it("accepts a signature bound to this method and path", async () => {
    const path = "/jobs/job-a/artifact";
    const res = await app().request(path, { headers: bound("GET", path, "") });
    expect(res.status).toBe(200);
  });

  it("accepts a legacy body-only signature in compat mode", async () => {
    const path = "/jobs/job-a/artifact";
    const res = await app().request(path, { headers: sign(SECRET, "") });
    expect(res.status).toBe(200);
  });

  it("rejects a legacy body-only signature in strict mode", async () => {
    const path = "/jobs/job-a/artifact";
    const res = await app({ hmacMode: "strict" }).request(path, { headers: sign(SECRET, "") });
    expect(res.status).toBe(401);
  });

  it("does not let an empty-body signature be replayed onto another job", async () => {
    // Captured for job-a's artifact; replayed at job-b's, and at cancel.
    const headers = bound("GET", "/jobs/job-a/artifact", "");
    const strict = app({ hmacMode: "strict" });

    expect((await strict.request("/jobs/job-b/artifact", { headers })).status).toBe(401);
    expect(
      (await strict.request("/jobs/job-a/cancel", { method: "POST", headers })).status,
    ).toBe(401);
  });

  it("rejects a tampered timestamp on a bound signature", async () => {
    const path = "/jobs/job-a/artifact";
    const headers = bound("GET", path, "");
    const res = await app({ hmacMode: "strict" }).request(path, {
      headers: { ...headers, [TIMESTAMP_HEADER]: String(Number(headers[TIMESTAMP_HEADER]) - 1) },
    });
    expect(res.status).toBe(401);
  });
});

describe("request body limit", () => {
  const oversized = "x".repeat(2048);

  it("rejects a body over the cap before authenticating it", async () => {
    const res = await app().request("/jobs", {
      method: "POST",
      // Unsigned on purpose: the cap must bite before the signature check.
      headers: { [SIGNATURE_HEADER]: "sha256=00", [TIMESTAMP_HEADER]: "0" },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized body that lies about its content-length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const res = await app().request("/jobs", {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: "sha256=00", [TIMESTAMP_HEADER]: "0", "content-length": "10" },
      // undici requires this for a streaming body.
      body,
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });
});
