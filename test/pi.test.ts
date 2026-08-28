import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  DEFAULT_PI_MODEL,
  PROVIDER_ID,
  PROVIDER_IDS,
  PROVIDERS,
  summaryOf,
  toTurn,
} from "../src/agent/pi.ts";

/**
 * The mapping from Pi's SDK events onto Ayos's transcript. This is the seam
 * that broke silently under the old ACP adapter — a session id mismatch there
 * dropped every event and the job still "succeeded" — so it is worth pinning
 * even though the events themselves are just data.
 */

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("toTurn", () => {
  it("maps a completed assistant message to agent_message", () => {
    expect(toTurn({ type: "message_end", message: assistant("I changed Foo.php.") })).toEqual({
      type: "agent_message",
      data: { text: "I changed Foo.php." },
    });
  });

  it("joins multiple text blocks in one message", () => {
    expect(
      toTurn({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      }),
    ).toEqual({ type: "agent_message", data: { text: "ab" } });
  });

  it("ignores non-text blocks such as tool calls inside a message", () => {
    expect(
      toTurn({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "1", name: "bash" }, { type: "text", text: "done" }],
        },
      }),
    ).toEqual({ type: "agent_message", data: { text: "done" } });
  });

  it("drops the user's own turn — the caller wrote it and already has it", () => {
    expect(toTurn({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } })).toBeNull();
  });

  it("drops an empty assistant message", () => {
    expect(toTurn({ type: "message_end", message: assistant("   ") })).toBeNull();
  });

  it("maps a tool execution start to tool_call", () => {
    expect(
      toTurn({
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "bash",
        args: { cmd: "ls" },
      }),
    ).toEqual({
      type: "tool_call",
      data: { tool_call_id: "call_1", name: "bash", title: "bash", input: { cmd: "ls" } },
    });
  });

  it("maps a tool execution end to tool_result", () => {
    expect(
      toTurn({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: "README.md\n",
        isError: false,
      }),
    ).toEqual({
      type: "tool_result",
      data: {
        tool_call_id: "call_1",
        name: "bash",
        status: "completed",
        output: "README.md\n",
      },
    });
  });

  it("marks a failed tool call as failed rather than hiding it", () => {
    const turn = toTurn({
      type: "tool_execution_end",
      toolCallId: "call_2",
      toolName: "edit",
      result: { content: [{ type: "text", text: "no such file" }] },
      isError: true,
    });
    expect(turn?.data.status).toBe("failed");
    expect(turn?.data.output).toBe("no such file");
  });

  it("stringifies a structured tool result rather than dropping it", () => {
    const turn = toTurn({
      type: "tool_execution_end",
      toolCallId: "call_3",
      toolName: "grep",
      result: { matches: 3 },
      isError: false,
    });
    expect(turn?.data.output).toBe('{"matches":3}');
  });

  /*
   * The deltas. Batched delivery means a partial message is never worth
   * sending: the completed one arrives moments later and says the same thing.
   */
  it.each(["message_start", "message_update", "bash_execution_update", "turn_start", "agent_start"])(
    "drops %s",
    (type) => {
      expect(toTurn({ type, message: assistant("half a th") })).toBeNull();
    },
  );
});

describe("summaryOf", () => {
  it("takes the LAST assistant message of the run", () => {
    expect(
      summaryOf([
        assistant("First I looked around."),
        { role: "user", content: [{ type: "text", text: "carry on" }] },
        assistant("I changed one line in Foo.php."),
      ]),
    ).toBe("I changed one line in Foo.php.");
  });

  it("is empty when the agent said nothing", () => {
    expect(summaryOf([])).toBe("");
    expect(summaryOf([assistant("  ")])).toBe("");
  });
});

describe("configuration", () => {
  it("gives the agent search tools, not just read/bash/edit/write", () => {
    expect(AGENT_TOOLS).toContain("grep");
    expect(AGENT_TOOLS).toContain("find");
    expect(AGENT_TOOLS).toContain("ls");
  });

  it("exposes nothing that could publish", () => {
    expect(AGENT_TOOLS).not.toContain("powershell");
    expect([...AGENT_TOOLS].sort()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "read", "write"].sort(),
    );
  });

  it("pins a model rather than letting the SDK pick one", () => {
    expect(DEFAULT_PI_MODEL).toBe("claude-sonnet-5");
  });
});

describe("providers", () => {
  it("describes every provider a spec may name", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDERS[id]).toBeDefined();
    }
    expect(Object.keys(PROVIDERS).sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it("speaks each provider's own wire API rather than assuming Anthropic's", () => {
    expect(PROVIDERS.anthropic.api).toBe("anthropic-messages");
    expect(PROVIDERS.openai.api).toBe("openai-responses");
    expect(PROVIDERS.openrouter.api).toBe("openai-completions");
  });

  it("pins a model per provider, because the same weights are named differently at each", () => {
    expect(PROVIDERS.anthropic.model).toBe("claude-sonnet-5");
    expect(PROVIDERS.openrouter.model).toBe("anthropic/claude-sonnet-5");
    expect(PROVIDERS.openai.model).not.toBe(PROVIDERS.anthropic.model);
  });

  it("gives every provider a distinct host, and defaults to Anthropic", () => {
    const hosts = PROVIDER_IDS.map((id) => PROVIDERS[id].host);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(PROVIDER_ID).toBe("anthropic");
  });
});
