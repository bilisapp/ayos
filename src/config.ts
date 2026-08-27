import { loadPublicKey } from "./auth/streamJwt.ts";
import type { KeyLike } from "jose";

export interface Config {
  port: number;
  sharedSecret: string;
  streamJwtPublicKey: KeyLike | null;
  allowedOrigin: string;
  maxConcurrentJobs: number;
  defaultTimeoutS: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) throw new Error(`env var ${name} must be a positive integer`);
  return n;
}

export async function loadConfig(): Promise<Config> {
  const pubKeyRaw = process.env.STREAM_JWT_PUBLIC_KEY;
  return {
    port: int("PORT", 8080),
    sharedSecret: required("AYOS_SHARED_SECRET"),
    // Optional so milestone-1 skeleton runs without streams configured; the
    // stream endpoint 503s rather than silently accepting anything.
    streamJwtPublicKey: pubKeyRaw ? await loadPublicKey(pubKeyRaw) : null,
    allowedOrigin: process.env.ALLOWED_ORIGIN ?? "",
    maxConcurrentJobs: int("MAX_CONCURRENT_JOBS", 4),
    defaultTimeoutS: int("DEFAULT_TIMEOUT_S", 900),
  };
}
