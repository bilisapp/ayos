#!/usr/bin/env node
/**
 * A complete Ayos caller in under a hundred lines, no dependencies.
 *
 * It asks the agent to translate a repository's README into Spanish — a task
 * that has nothing to do with bug-fixing, which is the point: Ayos knows no
 * domain vocabulary, so "run an agent against a repo, get a diff back" is the
 * entire integration surface. This script IS the caller: it signs the spec,
 * receives the signed callback on a throwaway local server, and leaves the
 * diff on disk for `git apply`.
 *
 *   AYOS_URL=http://localhost:8080 \
 *   AYOS_SHARED_SECRET=... \        # from `pnpm keygen`
 *   GITHUB_TOKEN=... \              # clone-scoped PAT
 *   ANTHROPIC_API_KEY=... \
 *   node examples/translate-readme.mjs org/repo main <base-sha>
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const [repo, baseRef = "main", baseSha] = process.argv.slice(2);
const AYOS = process.env.AYOS_URL ?? "http://localhost:8080";
const SECRET = process.env.AYOS_SHARED_SECRET;
if (!repo || !baseSha || !SECRET) {
  console.error("usage: translate-readme.mjs org/repo <branch> <base-sha>  (plus env, see header)");
  process.exit(1);
}

// The signature covers the RAW BODY only; the timestamp rides beside it as a
// header and is checked against a ±5 minute window.
const sign = (body) => ({
  "x-ayos-signature": "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex"),
  "x-ayos-timestamp": Math.floor(Date.now() / 1000).toString(),
});

// 1. A local endpoint for the artifact callback — the whole "webhook receiver".
const artifact = new Promise((resolve) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const expected = sign(body)["x-ayos-signature"];
      if (req.headers["x-ayos-signature"] !== expected) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200).end(JSON.stringify({ applied: true }));
      server.close();
      resolve(JSON.parse(body));
    });
  }).listen(8125);
});

// 2. The job spec — the entire contract. Nothing here is autofix-shaped.
const spec = JSON.stringify({
  job_id: crypto.randomUUID(),
  repo,
  base_ref: baseRef,
  base_sha: baseSha,
  clone_token: process.env.GITHUB_TOKEN,
  llm_key: process.env.ANTHROPIC_API_KEY,
  task: {
    instructions: [
      "Create README.es.md: a faithful Spanish translation of README.md.",
      "Keep all code blocks, command names and file paths untranslated.",
      "Do not modify README.md or any other file.",
    ].join("\n"),
  },
  constraints: { test_cmd: null, max_diff_lines: 2000 },
  // Ayos delivers the artifact here. With `pnpm dev` (ayos on the host) this
  // is reachable as-is; a dockerised Ayos needs host.docker.internal instead.
  callback_url: "http://localhost:8125/artifact",
});

// 3. One signed POST starts the job.
const res = await fetch(`${AYOS}/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json", ...sign(spec) },
  body: spec,
});
if (!res.ok) {
  console.error("POST /jobs failed:", res.status, await res.text());
  process.exit(1);
}
console.log("job accepted:", (await res.json()).job_id ?? "(queued)");

// 4. One signed POST comes back.
const result = await artifact;
console.log(`status: ${result.status} — ${result.report.summary}`);
if (result.diff) {
  writeFileSync("translation.patch", result.diff);
  console.log("diff written to translation.patch — review it, then: git apply translation.patch");
} else if (result.report.error) {
  console.error("no diff:", result.report.error);
}
