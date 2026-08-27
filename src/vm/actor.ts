import { agentOS, setup, createHostDirBackend } from "@rivet-dev/agentos";
import pi from "@agentos-software/pi";
import ripgrep from "@agentos-software/ripgrep";
import jq from "@agentos-software/jq";
import { vmPermissions } from "../sandbox/permissions.ts";
import { WORKDIR } from "../git/clone.ts";

export interface VmInput {
  /** Hosts this VM may reach. Everything else is denied. */
  egressAllowlist: string[];
  /** Host path of the checkout to mount at WORKDIR. */
  hostRepoPath: string;
}

/**
 * One job = one VM actor. The egress allowlist arrives as actor input and is
 * turned into agentOS permissions by `resolveOptions`, which runs per actor
 * instance — that is what lets the allowlist differ per job rather than being
 * baked into the definition.
 */
export interface VmState {
  egressAllowlist: string[];
  hostRepoPath: string;
}

export const vm = agentOS<VmState, undefined, undefined, undefined, VmInput>({
  createState: (_c, input) => ({
    egressAllowlist: input?.egressAllowlist ?? [],
    hostRepoPath: input?.hostRepoPath ?? "",
  }),
  resolveOptions: (c) => {
    const state = (c as unknown as { state: VmState }).state;
    return {
      // `pi` is the agent itself; `rg` and `jq` are not in the guest's base set.
      //
      // Verified in a live VM, because none of this is documented: a `software`
      // command runs when the actor execs it directly (`process.execFile("rg",
      // …)` works), but NOT from inside a shell — `sh -lc 'rg …'` fails with
      // `exit 126, Permission denied (os error 2)` even given the absolute
      // path, while base-set commands like `sed` run fine there. So these help
      // anything Ayos execs itself; whether the agent can reach them depends on
      // how pi spawns its tools.
      //
      // Two more surprises worth knowing: `rg` needs an ABSOLUTE path (`rg x .`
      // fails with os error 44 on the mount), and it does not honour the repo's
      // .gitignore, so it will happily walk vendor/.
      software: [pi, ripgrep, jq],
      permissions: vmPermissions(state.egressAllowlist),
      // The repo lives on the host and is projected in. `readOnly` defaults to
      // TRUE, so it must be set explicitly or the agent cannot edit anything.
      mounts: state.hostRepoPath
        ? [
            {
              path: WORKDIR,
              plugin: createHostDirBackend({ hostPath: state.hostRepoPath, readOnly: false }),
              readOnly: false,
            },
          ]
        : [],
    };
  },
  actions: {
    /**
     * Teardown has to be initiated from inside the actor — agentOS exposes no
     * destroy action and the client handle has none, so without this the VM
     * would only ever idle-sleep, keeping its filesystem (and the repo, and
     * whatever the agent wrote) alive well past the end of the job.
     */
    shutdown: (c: { destroy(): void }) => {
      c.destroy();
      return "destroying";
    },
  },
});

/**
 * `startEngine: false` when AYOS_EXTERNAL_ENGINE=1 — rivetkit 2.3.9's own engine
 * boot fails its health check on macOS arm64 (the engine binds and finishes
 * backfills well after rivetkit gives up), so local dev runs the engine as a
 * separate process. See `pnpm engine` and the README.
 */
export const registry = setup({
  use: { vm },
  ...(process.env.AYOS_EXTERNAL_ENGINE === "1" ? { startEngine: false } : {}),
});

export type VmRegistry = typeof registry;
