/**
 * Mints the Ed25519 keypair used for browser stream tokens, plus a shared
 * secret. Ayos gets the PUBLIC key only; the caller keeps the private key and
 * is the only party that can mint stream tokens.
 *
 *   pnpm keygen
 */
import { generateKeyPair, exportSPKI, exportPKCS8, exportJWK } from "jose";
import { randomBytes } from "node:crypto";

const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true,
});

const spki = await exportSPKI(publicKey);
const pkcs8 = await exportPKCS8(privateKey);
const secret = randomBytes(32).toString("hex");

// The 32-byte Ed25519 seed, base64. PHP's sodium takes this directly
// (sodium_crypto_sign_seed_keypair), which saves the caller parsing PEM.
const jwk = await exportJWK(privateKey);
const seedB64 = Buffer.from(jwk.d as string, "base64url").toString("base64");

const oneLine = (pem: string) => pem.trim().replace(/\n/g, "\\n");

console.log("# ---- Ayos (.env) ----------------------------------------------");
console.log(`AYOS_SHARED_SECRET=${secret}`);
console.log(`STREAM_JWT_PUBLIC_KEY="${oneLine(spki)}"`);
console.log("");
console.log("# ---- Caller, e.g. Laravel (.env) ------------------------------");
console.log("# Same shared secret, both directions (dispatch + artifact callback).");
console.log(`AYOS_SHARED_SECRET=${secret}`);
console.log("# Private key — mints stream tokens. Ayos never sees this.");
console.log(`AYOS_STREAM_JWT_PRIVATE_KEY="${oneLine(pkcs8)}"`);
console.log("# Same key as a raw seed, for PHP/sodium (see README).");
console.log(`AYOS_STREAM_JWT_SEED=${seedB64}`);
