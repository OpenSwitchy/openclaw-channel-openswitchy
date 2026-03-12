import { describe, it, expect, vi, beforeEach } from "vitest";
import { openswitchyChannel, resolveAgentName, resolveAgentDescription } from "./channel.js";
import type { AccountConfig } from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

/* ── Helper to build a fake OpenClawConfig ── */

function makeConfig(accounts?: Record<string, AccountConfig>) {
  return { channels: { openswitchy: { accounts } } } as unknown;
}

/* ── resolveAgentName ── */

describe("resolveAgentName", () => {
  function makeCfg(overrides: Record<string, unknown> = {}): OpenClawConfig {
    return {
      bindings: [
        {
          match: { channel: "openswitchy", accountId: "default" },
          agentId: "agent-1",
        },
      ],
      agents: {
        list: [
          {
            id: "agent-1",
            name: "FallbackName",
            identity: { name: "PaymentsBot" },
          },
        ],
      },
      ...overrides,
    } as unknown as OpenClawConfig;
  }

  it("returns agent identity.name when binding + agent found", () => {
    const cfg = makeCfg();
    expect(resolveAgentName(cfg, "default", "fallback")).toBe("PaymentsBot");
  });

  it("returns agent.name when identity.name is missing", () => {
    const cfg = makeCfg({
      agents: {
        list: [{ id: "agent-1", name: "AgentOne" }],
      },
    });
    expect(resolveAgentName(cfg, "default", "fallback")).toBe("AgentOne");
  });

  it("returns agentId when agent not in list", () => {
    const cfg = makeCfg({
      agents: { list: [] },
    });
    expect(resolveAgentName(cfg, "default", "fallback")).toBe("agent-1");
  });

  it("returns fallback when no binding matches", () => {
    const cfg = makeCfg({ bindings: [] });
    expect(resolveAgentName(cfg, "default", "fallback")).toBe("fallback");
  });

  it("returns fallback when binding has no agentId", () => {
    const cfg = makeCfg({
      bindings: [{ match: { channel: "openswitchy", accountId: "default" } }],
    });
    expect(resolveAgentName(cfg, "default", "myFallback")).toBe("myFallback");
  });

  it("matches binding without accountId constraint", () => {
    const cfg = makeCfg({
      bindings: [
        { match: { channel: "openswitchy" }, agentId: "agent-1" },
      ],
    });
    expect(resolveAgentName(cfg, "any-account", "fallback")).toBe("PaymentsBot");
  });

  it("handles missing bindings and agents gracefully", () => {
    const cfg = {} as unknown as OpenClawConfig;
    expect(resolveAgentName(cfg, "default", "safe")).toBe("safe");
  });
});

/* ── resolveAgentDescription ── */

describe("resolveAgentDescription", () => {
  function makeCfg(overrides: Record<string, unknown> = {}): OpenClawConfig {
    return {
      bindings: [
        {
          match: { channel: "openswitchy", accountId: "default" },
          agentId: "agent-1",
        },
      ],
      agents: {
        list: [
          {
            id: "agent-1",
            name: "FallbackName",
            identity: { name: "PaymentsBot", description: "Handles billing and invoices" },
          },
        ],
      },
      ...overrides,
    } as unknown as OpenClawConfig;
  }

  it("returns identity.description when binding + agent found", () => {
    const cfg = makeCfg();
    expect(resolveAgentDescription(cfg, "default", "Fallback")).toBe("Handles billing and invoices");
  });

  it("falls back to generic description when identity.description missing", () => {
    const cfg = makeCfg({
      agents: { list: [{ id: "agent-1", name: "Bot", identity: { name: "Bot" } }] },
    });
    expect(resolveAgentDescription(cfg, "default", "Bot")).toBe("OpenClaw agent: Bot");
  });

  it("falls back to generic description when no binding", () => {
    const cfg = makeCfg({ bindings: [] });
    expect(resolveAgentDescription(cfg, "default", "MyBot")).toBe("OpenClaw agent: MyBot");
  });

  it("falls back to generic description when agent not in list", () => {
    const cfg = makeCfg({ agents: { list: [] } });
    expect(resolveAgentDescription(cfg, "default", "MyBot")).toBe("OpenClaw agent: MyBot");
  });

  it("handles empty config gracefully", () => {
    const cfg = {} as unknown as OpenClawConfig;
    expect(resolveAgentDescription(cfg, "default", "Safe")).toBe("OpenClaw agent: Safe");
  });
});

/* ── Config Adapter ── */

describe("config adapter", () => {
  const { config } = openswitchyChannel;

  it("listAccountIds returns account IDs from config", () => {
    const cfg = makeConfig({
      default: { joinCode: "abc", agentName: "Bot" },
      work: { joinCode: "xyz", agentName: "WorkBot" },
    });
    expect(config.listAccountIds(cfg as any)).toEqual(["default", "work"]);
  });

  it("listAccountIds returns empty array when no config", () => {
    expect(config.listAccountIds({} as any)).toEqual([]);
  });

  it("listAccountIds returns empty when no accounts section", () => {
    const cfg = { channels: { openswitchy: {} } };
    expect(config.listAccountIds(cfg as any)).toEqual([]);
  });

  it("resolveAccount returns the correct account config", () => {
    const cfg = makeConfig({
      default: { joinCode: "abc", agentName: "Bot1" },
      work: { joinCode: "xyz", agentName: "Bot2" },
    });
    const account = config.resolveAccount(cfg as any, "work");
    expect(account).toEqual({ joinCode: "xyz", agentName: "Bot2" });
  });

  it("resolveAccount falls back to first account when ID not found", () => {
    const cfg = makeConfig({
      default: { joinCode: "abc", agentName: "Bot1" },
    });
    const account = config.resolveAccount(cfg as any, "nonexistent");
    expect(account).toEqual({ joinCode: "abc", agentName: "Bot1" });
  });

  it("resolveAccount returns empty object when no accounts", () => {
    const account = config.resolveAccount({} as any, "anything");
    expect(account).toEqual({});
  });

  it("isConfigured returns true when joinCode is set", () => {
    expect(config.isConfigured!({ joinCode: "abc" }, {} as any)).toBe(true);
  });

  it("isConfigured returns true when joinCode + agentName are set", () => {
    expect(config.isConfigured!({ joinCode: "abc", agentName: "Bot" }, {} as any)).toBe(true);
  });

  it("isConfigured returns false when joinCode is missing", () => {
    expect(config.isConfigured!({ agentName: "Bot" }, {} as any)).toBe(false);
  });

  it("isConfigured returns false for empty config", () => {
    expect(config.isConfigured!({}, {} as any)).toBe(false);
  });

  it("isEnabled returns true by default", () => {
    expect(config.isEnabled!({}, {} as any)).toBe(true);
  });

  it("isEnabled returns false when explicitly disabled", () => {
    expect(config.isEnabled!({ enabled: false }, {} as any)).toBe(false);
  });

  it("isEnabled returns true when explicitly enabled", () => {
    expect(config.isEnabled!({ enabled: true }, {} as any)).toBe(true);
  });
});

/* ── Meta & Capabilities ── */

describe("meta and capabilities", () => {
  it("has correct id", () => {
    expect(openswitchyChannel.id).toBe("openswitchy");
  });

  it("meta.label is OpenSwitchy", () => {
    expect(openswitchyChannel.meta.label).toBe("OpenSwitchy");
  });

  it("meta has docsPath", () => {
    expect(openswitchyChannel.meta.docsPath).toBe("channels/openswitchy");
  });

  it("supports direct and group chats", () => {
    expect(openswitchyChannel.capabilities.chatTypes).toContain("direct");
    expect(openswitchyChannel.capabilities.chatTypes).toContain("group");
  });
});

/* ── Security Adapter ── */

describe("security adapter", () => {
  const security = openswitchyChannel.security!;

  it("resolveDmPolicy returns open by default", () => {
    const result = security.resolveDmPolicy!({
      cfg: {} as any,
      account: {},
    });
    expect(result?.policy).toBe("open");
  });

  it("resolveDmPolicy returns configured policy", () => {
    const result = security.resolveDmPolicy!({
      cfg: {} as any,
      account: { dmPolicy: "pairing" },
    });
    expect(result?.policy).toBe("pairing");
  });

  it("resolveDmPolicy includes allowFromPath", () => {
    const result = security.resolveDmPolicy!({
      cfg: {} as any,
      account: {},
    });
    expect(result?.allowFromPath).toBe("channels.openswitchy.allowFrom");
  });
});

/* ── Outbound Adapter ── */

describe("outbound adapter", () => {
  const outbound = openswitchyChannel.outbound!;

  it("textChunkLimit is 4096", () => {
    expect(outbound.textChunkLimit).toBe(4096);
  });

  it("deliveryMode is direct", () => {
    expect(outbound.deliveryMode).toBe("direct");
  });

  it("sendText throws when no active connection", async () => {
    await expect(
      outbound.sendText!({
        cfg: {} as any,
        to: "room-123",
        text: "hello",
        accountId: "nonexistent",
      }),
    ).rejects.toThrow("No active connection");
  });
});

/* ── Gateway Adapter ── */

describe("gateway adapter", () => {
  const gateway = openswitchyChannel.gateway!;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("startAccount throws when joinCode is missing", async () => {
    const ctx = {
      cfg: {} as any,
      accountId: "test",
      account: { agentName: "Bot" } as AccountConfig,
      abortSignal: new AbortController().signal,
      runtime: {} as any,
      getStatus: vi.fn(),
      setStatus: vi.fn(),
    };
    await expect(gateway.startAccount!(ctx as any)).rejects.toThrow("Missing joinCode");
  });

  it("startAccount works without agentName (auto-resolves)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          agentId: "agent-1",
          name: "ResolvedBot",
          orgId: "org-1",
          orgName: "TestOrg",
          apiKey: "sb_test_key",
          status: "approved",
          message: "Registered",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const abortController = new AbortController();
    const ctx = {
      cfg: {
        bindings: [
          { match: { channel: "openswitchy", accountId: "test-acc" }, agentId: "agent-1" },
        ],
        agents: {
          list: [{ id: "agent-1", name: "AutoBot", identity: { name: "AutoResolvedName", description: "Auto-resolved description from config" } }],
        },
      } as any,
      accountId: "test-acc",
      account: { joinCode: "abc", url: "http://localhost:3000" } as AccountConfig,
      abortSignal: abortController.signal,
      runtime: {} as any,
      getStatus: vi.fn(),
      setStatus: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    // Abort after a tick so startAccount unblocks
    setTimeout(() => abortController.abort(), 50);
    await gateway.startAccount!(ctx as any);

    // Should register with auto-resolved name and description
    const registerCall = mockFetch.mock.calls[0];
    const body = JSON.parse(registerCall[1].body);
    expect(body.name).toBe("AutoResolvedName");
    expect(body.description).toBe("Auto-resolved description from config");

    vi.unstubAllGlobals();
  });

  it("startAccount prefers manual agentName over auto-resolved", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          agentId: "agent-1",
          name: "ManualBot",
          orgId: "org-1",
          orgName: "TestOrg",
          apiKey: "sb_test_key",
          status: "approved",
          message: "Registered",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const abortController = new AbortController();
    const ctx = {
      cfg: {
        bindings: [
          { match: { channel: "openswitchy", accountId: "test-acc" }, agentId: "agent-1" },
        ],
        agents: {
          list: [{ id: "agent-1", identity: { name: "AutoName" } }],
        },
      } as any,
      accountId: "test-acc",
      account: {
        joinCode: "abc",
        agentName: "ManualBot",
        agentDescription: "Custom description",
        url: "http://localhost:3000",
      } as AccountConfig,
      abortSignal: abortController.signal,
      runtime: {} as any,
      getStatus: vi.fn(),
      setStatus: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    setTimeout(() => abortController.abort(), 50);
    await gateway.startAccount!(ctx as any);

    const registerCall = mockFetch.mock.calls[0];
    const body = JSON.parse(registerCall[1].body);
    expect(body.name).toBe("ManualBot");
    expect(body.description).toBe("Custom description");

    vi.unstubAllGlobals();
  });

  it("startAccount registers and stores connection", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          agentId: "agent-1",
          name: "TestBot",
          orgId: "org-1",
          orgName: "TestOrg",
          apiKey: "sb_test_key",
          status: "approved",
          message: "Registered",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const abortController = new AbortController();
    const ctx = {
      cfg: {} as any,
      accountId: "test-acc",
      account: { joinCode: "abc", agentName: "TestBot", url: "http://localhost:3000" } as AccountConfig,
      abortSignal: abortController.signal,
      runtime: {} as any,
      getStatus: vi.fn(),
      setStatus: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    setTimeout(() => abortController.abort(), 50);
    await gateway.startAccount!(ctx as any);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/register",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"joinCode":"abc"'),
      }),
    );

    vi.unstubAllGlobals();
  });

  it("stopAccount cleans up", async () => {
    const ctx = {
      cfg: {} as any,
      accountId: "nonexistent-acc",
      account: {} as AccountConfig,
      abortSignal: new AbortController().signal,
      runtime: {} as any,
      getStatus: vi.fn(),
      setStatus: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    await expect(gateway.stopAccount!(ctx as any)).resolves.toBeUndefined();
  });
});
