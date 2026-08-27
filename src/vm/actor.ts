import { agentOS, setup } from "@rivet-dev/agentos";
import pi from "@agentos-software/pi";
import { vmPermissions } from "../sandbox/permissions.ts";

export interface VmInput {
  /** Hosts this VM may reach. Everything else is denied. */
  egressAllowlist: string[];
}

/**
 * One job = one VM actor. The egress allowlist arrives as actor input and is
 * turned into agentOS permissions by `resolveOptions`, which runs per actor
 * instance — that is what lets the allowlist differ per job rather than being
 * baked into the definition.
 */
export interface VmState {
  egressAllowlist: string[];
}

export const vm = agentOS<VmState, undefined, undefined, undefined, VmInput>({
  createState: (_c, input) => ({ egressAllowlist: input?.egressAllowlist ?? [] }),
  resolveOptions: (c) => ({
    software: [pi],
    permissions: vmPermissions((c as unknown as { state: VmState }).state.egressAllowlist),
  }),
});

export const registry = setup({ use: { vm } });

export type VmRegistry = typeof registry;
