/**
 * Generates one Ed25519 keypair, for local testing.
 *
 * In production these are minted **per job** by the control plane: it keeps the
 * public half on the job record and injects the private half into that one run.
 * There is no long-lived key to generate any more, and nothing here belongs in
 * a deployment's environment — this exists so `pnpm run:local` has something to
 * sign with.
 */
import { generateKeyPairSync } from "node:crypto";
import { publicKeyBase64 } from "../src/auth/sign.ts";

const { privateKey } = generateKeyPairSync("ed25519");
// The 32-byte seed, which is what libsodium's `sodium_crypto_sign_seed_keypair`
// takes on the PHP side — the same shape Bilis already stores for stream tokens.
const seed = Buffer.from(
  privateKey.export({ format: "der", type: "pkcs8" }).subarray(16),
).toString("base64");

console.log("# The caller keeps this, and puts it on the job row:");
console.log(`public_key  = ${publicKeyBase64(privateKey)}`);
console.log("");
console.log("# The caller injects this into the one run it belongs to:");
console.log(`signing_key = ${seed}`);
