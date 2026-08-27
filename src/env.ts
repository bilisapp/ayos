import { readFileSync } from "node:fs";

/**
 * Load ./.env into process.env before config is read. File values win over
 * inherited environment: RUNNING.md documents .env as the config surface for
 * local runs, so editing it and restarting must always take effect, even when
 * the launching shell still exports stale values from an earlier `source .env`.
 * No file (the production/Docker path) is a silent no-op — real env applies.
 */
export function loadDotEnv(path = ".env"): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const key = match[1]!;
    let value = match[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
