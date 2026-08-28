#!/usr/bin/env node
/**
 * A complete Ayos caller in under a hundred lines, no dependencies.
 *
 * It asks the agent to translate a repository's README into Spanish — a task
 * that has nothing to do with bug-fixing, which is the point: Ayos knows no
 * domain vocabulary, so "run an agent against a repo, get a diff back" is the
 * entire integration surface.
 *
 * This script IS the control plane, in miniature. It mints a keypair for the
 * one run, hands the private half to the run and keeps the public half,
 * receives the signed callback, and verifies it. Here the run is a local
 * process; in production it is a Serverless Job run started through the
 * platform's API. Nothing else about the contract changes — which is the whole
 * argument for a runner with no inbound HTTP.
 *
 *   GITHUB_TOKEN=... ANTHROPIC_API_KEY=... \
 *   node examples/translate-readme.mjs org/repo main <base-sha>
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPairSync, verify } from "node:crypto";
import { writeFileSync } from "node:fs";

const [repo, baseRef = "main", baseSha] = process.argv.slice(2);
if (!repo || !baseSha || !process.env.GITHUB_TOKEN || !process.env.ANTHROPIC_API_KEY) {
  console.error("usage: translate-readme.mjs org/repo <branch> <base-sha>  (plus env, see header)");
  process.exit(1);
}

// 1. One keypair for one job. The run signs with the private half; we verify
//    with the public one and then forget both. There is no shared secret.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signingKey = Buffer.from(
  privateKey.export({ format: "der", type: "pkcs8" }).subarray(16),
).toString("base64");

const verifyCallback = (timestamp, body, signature) => {
  if (!signature?.startsWith("ed25519=") || !timestamp) return false;
  return verify(
    null,
    Buffer.from(`${timestamp}.${body}`, "utf8"),
    publicKey,
    Buffer.from(signature.slice("ed25519=".length), "base64"),
  );
};

// 2. A local endpoint for the artifact callback — the whole "webhook receiver".
const artifact = new Promise((resolve) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!verifyCallback(req.headers["x-ayos-timestamp"], body, req.headers["x-ayos-signature"])) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200).end(JSON.stringify({ applied: true }));
      server.close();
      resolve(JSON.parse(body));
    });
  }).listen(8125);
});

// 3. The job spec — the entire contract. Nothing here is autofix-shaped.
const spec = JSON.stringify({
  job_id: crypto.randomUUID(),
  repo,
  base_ref: baseRef,
  base_sha: baseSha,
  clone_token: process.env.GITHUB_TOKEN,
  llm_key: process.env.ANTHROPIC_API_KEY,
  signing_key: signingKey,
  task: {
    instructions: [
      "Create README.es.md: a faithful Spanish translation of README.md.",
      "Keep all code blocks, command names and file paths untranslated.",
      "Do not modify README.md or any other file.",
    ].join("\n"),
  },
  constraints: { test_cmd: null, max_diff_lines: 2000 },
  callback_url: "http://localhost:8125/artifact",
});

// 4. Start the run. Locally that is a child process; in production it is
//    `POST /jobs/{id}/runs` against the platform, with `AYOS_JOB_SPEC` set as
//    a per-run environment variable exactly as it is here.
const run = spawn(process.execPath, ["--import", "tsx", "src/entry.ts"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, AYOS_JOB_SPEC: spec },
});
run.on("exit", (code) => code !== 0 && console.error(`run exited ${code}`));

// 5. One signed POST comes back.
const result = await artifact;
console.log(`status: ${result.status} — ${result.report.summary}`);
if (result.diff) {
  writeFileSync("translation.patch", result.diff);
  console.log("diff written to translation.patch — review it, then: git apply translation.patch");
} else if (result.report.error) {
  console.error("no diff:", result.report.error);
}
