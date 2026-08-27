/**
 * Mirrors agentos-core's `Permissions` (runtime-compat.d.ts). Declared locally
 * because agentos-core is a transitive package that npm marks as "not a
 * supported user-facing install target" — we want the shape, not the dep.
 *
 * Note: the generated TS type claims `PermissionMode` includes `"ask"`, but the
 * runtime zod schema is `z.enum(["allow","deny"])` and `"ask"` throws at
 * `AgentOs.create()`. Two values only.
 */
type PermissionMode = "allow" | "deny";

interface PatternPermissionRule {
  mode: PermissionMode;
  operations?: string[];
  patterns?: string[];
}

interface FsPermissionRule {
  mode: PermissionMode;
  operations?: string[];
  paths?: string[];
}

export type NetworkPermissions =
  | PermissionMode
  | { default?: PermissionMode; rules: PatternPermissionRule[] };

export interface Permissions {
  fs?: PermissionMode | { default?: PermissionMode; rules: FsPermissionRule[] };
  network?: NetworkPermissions;
  childProcess?: PermissionMode | { default?: PermissionMode; rules: PatternPermissionRule[] };
  process?: PermissionMode | { default?: PermissionMode; rules: PatternPermissionRule[] };
  env?: PermissionMode | { default?: PermissionMode; rules: PatternPermissionRule[] };
  binding?: PermissionMode | { default?: PermissionMode; rules: PatternPermissionRule[] };
}

/** Ports we allow to an allowlisted host. Anything else is denied. */
const ALLOWED_PORTS = [443, 80] as const;

/**
 * Deny-by-default egress — the prompt-injection blast-radius control. If the
 * agent is talked into exfiltrating something, it has nowhere to send it.
 *
 * Two details that are easy to get wrong and were verified against a live VM:
 *
 * - `operations` takes BARE tokens (`http`, `fetch`, `dns`, `listen`). The denial
 *   message reads "blocked by network.http policy", but `"network.http"` as an
 *   operation matches nothing.
 * - `patterns` match the full resource URI (`tcp://host:443`), not a bare
 *   hostname, and are minimatch globs where `*` does not cross `/`. A bare
 *   hostname pattern matches nothing.
 *
 * DNS needs no rule: resolution of an allowlisted host succeeds as part of the
 * http/fetch grant, and an IP literal is matched as written, so there is no
 * resolve-then-connect bypass.
 */
export function networkPermissions(allowlist: readonly string[]): NetworkPermissions {
  return {
    default: "deny",
    rules: [
      {
        mode: "allow",
        operations: ["http", "fetch"],
        patterns: allowlist.flatMap((host) => ALLOWED_PORTS.map((port) => `tcp://${host}:${port}`)),
      },
    ],
  };
}

/**
 * `permissions` REPLACES the default policy object rather than merging into it,
 * so every scope we don't name becomes deny — which silently breaks the agent
 * (its first `bash` call dies with "blocked by child_process.spawn policy").
 * Every scope is therefore listed explicitly.
 *
 * Only `network` is restricted. Filesystem containment comes from the diff we
 * package — the agent's edits are only ever proposed, never applied by us — plus
 * the denylist check, not from fs rules: Pi needs to read its own installation,
 * $HOME and /tmp, and an fs allowlist tight enough to matter would break it.
 */
export function vmPermissions(allowlist: readonly string[]): Permissions {
  return {
    network: networkPermissions(allowlist),
    fs: "allow",
    childProcess: "allow",
    process: "allow",
    env: "allow",
    binding: "allow",
  };
}

/**
 * Proves the allowlist is actually enforced before we hand the VM a credential.
 *
 * A malformed rule fails CLOSED (deny-by-default with no matching allow), but a
 * rule that accidentally matches everything fails OPEN, and that is the one
 * outcome we cannot ship. One probe per job turns a silent misconfiguration into
 * a failed job.
 */
export const CANARY_HOST = "example.com";

export async function assertEgressEnforced(
  probe: (host: string) => Promise<{ reachable: boolean }>,
  allowlist: readonly string[],
): Promise<void> {
  if (allowlist.includes(CANARY_HOST)) return; // pathological config; skip rather than lie
  const { reachable } = await probe(CANARY_HOST);
  if (reachable)
    throw new Error(
      `egress allowlist is not being enforced: ${CANARY_HOST} was reachable from the VM`,
    );
}
