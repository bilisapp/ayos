/**
 * Signs a job spec and POSTs it, so you can exercise Ayos without the caller
 * being ready. Also prints the equivalent curl.
 *
 *   pnpm sign job.json                 # POST /jobs
 *   pnpm sign job.json --print         # just show the headers + curl
 *   pnpm sign --cancel <job_id>        # POST /jobs/:id/cancel
 *   pnpm sign --artifact <job_id>      # GET  /jobs/:id/artifact
 *   pnpm sign job.json --bound         # sign timestamp.METHOD.path.body
 *
 * `--bound` is what a server running AYOS_HMAC_MODE=strict expects.
 */
import { readFile } from "node:fs/promises";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/auth/hmac.ts";

const secret = process.env.AYOS_SHARED_SECRET;
if (!secret) {
  console.error("AYOS_SHARED_SECRET is not set");
  process.exit(1);
}

const base = process.env.AYOS_URL ?? "http://localhost:8080";
const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const bound = args.includes("--bound");

let url: string;
let method: "GET" | "POST";
let body = "";

const cancelIdx = args.indexOf("--cancel");
const artifactIdx = args.indexOf("--artifact");

if (cancelIdx !== -1) {
  const id = args[cancelIdx + 1];
  if (!id) throw new Error("--cancel needs a job id");
  url = `${base}/jobs/${id}/cancel`;
  method = "POST";
} else if (artifactIdx !== -1) {
  const id = args[artifactIdx + 1];
  if (!id) throw new Error("--artifact needs a job id");
  url = `${base}/jobs/${id}/artifact`;
  method = "GET";
} else {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("usage: pnpm sign <job.json>");
  // Re-serialize so the bytes we sign are exactly the bytes we send.
  body = JSON.stringify(JSON.parse(await readFile(file, "utf8")));
  url = `${base}/jobs`;
  method = "POST";
}

const headers = sign(
  secret,
  body,
  undefined,
  bound ? { method, path: new URL(url).pathname } : undefined,
);

console.log(`${method} ${url}`);
console.log(`${SIGNATURE_HEADER}: ${headers[SIGNATURE_HEADER]}`);
console.log(`${TIMESTAMP_HEADER}: ${headers[TIMESTAMP_HEADER]}`);
console.log("");
console.log(
  [
    `curl -sS -X ${method} '${url}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H '${SIGNATURE_HEADER}: ${headers[SIGNATURE_HEADER]}' \\`,
    `  -H '${TIMESTAMP_HEADER}: ${headers[TIMESTAMP_HEADER]}'${body ? " \\" : ""}`,
    body ? `  -d '${body.replace(/'/g, "'\\''")}'` : "",
  ]
    .filter(Boolean)
    .join("\n"),
);

if (printOnly) process.exit(0);

const res = await fetch(url, {
  method,
  headers: { "content-type": "application/json", ...headers },
  ...(body ? { body } : {}),
});
console.log(`\n--- ${res.status} ${res.statusText} ---`);
console.log(await res.text());
