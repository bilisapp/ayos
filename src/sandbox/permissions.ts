import { WORKDIR } from "../git/clone.ts";

/**
 * Mirrors agentos-core's `Permissions` (runtime-compat.d.ts). Declared locally
 * because agentos-core is a transitive package that npm marks as "not a
 * supported user-facing install target" — we want the shape, not the dep.
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

export type NetworkPermissions = PermissionMode | { default?: PermissionMode; rules: PatternPermissionRule[] };

export interface Permissions {
  fs?: PermissionMode | { default?: PermissionMode; rules: FsPermissionRule[] };
  network?: NetworkPermissions;
  childProcess?: NetworkPermissions;
  process?: NetworkPermissions;
  env?: NetworkPermissions;
  binding?: NetworkPermissions;
}

/**
 * Deny-by-default egress. This is the prompt-injection blast-radius control: if
 * the agent is talked into exfiltrating something, it has nowhere to send it.
 *
 * NOTE: agentOS's `PatternPermissionRule` is `{ mode, operations?, patterns? }`
 * (verified in agentos-core's runtime-compat.d.ts) but the accepted `operations`
 * vocabulary and the `patterns` matching syntax are not described in the type
 * definitions. `assertEgressEnforced` below exists because a rule that silently
 * fails to match would fail OPEN — the one failure mode we cannot accept here.
 */
export function networkPermissions(allowlist: readonly string[]): NetworkPermissions {
  return {
    default: "deny",
    rules: allowlist.map((host) => ({
      mode: "allow" as const,
      patterns: [host, `${host}:*`, `*://${host}`, `*://${host}/*`],
    })),
  };
}

export function vmPermissions(allowlist: readonly string[]): Permissions {
  return {
    network: networkPermissions(allowlist),
    // The agent works in the repo and nowhere else. `deny` is the default so a
    // path we forgot to think about is denied rather than allowed.
    fs: {
      default: "deny",
      rules: [
        { mode: "allow", paths: [WORKDIR, `${WORKDIR}/**`] },
        { mode: "allow", paths: ["/tmp", "/tmp/**"] },
      ],
    },
  };
}

/**
 * Proves the allowlist is actually enforced before we hand the VM a credential.
 * Called once per job: reach a host that must be denied and fail the job if the
 * request succeeds. Cheap, and it turns a silent misconfiguration into a loud one.
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
