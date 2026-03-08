import { describe, it, expect, vi, beforeEach } from "vitest";
import { openswitchyChannel } from "./channel.js";
import type { AccountConfig } from "./types.js";

/* ── Helper to build a fake OpenClawConfig ── */

function makeConfig(accounts?: Record<string, AccountConfig>) {
  return { channels: { openswitchy: { accounts } } } as unknown;
}

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

  it("isConfigured returns true when joinCode and agentName are set", () => {
    expect(config.isConfigured!({ joinCode: "abc", agentName: "Bot" }, {} as any)).toBe(true);
  });

  it("isConfigured returns false when joinCode is missing", () => {
    expect(config.isConfigured!({ agentName: "Bot" }, {} as any)).toBe(false);
  });

  it("isConfigured returns false when agentName is missing", () => {
    expect(config.isConfigured!({ joinCode: "abc" }, {} as any)).toBe(false);
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
    await expect(gateway.startAccount!(ctx as any)).rejects.toThrow("Missing joinCode or agentName");
  });

  it("startAccount throws when agentName is missing", async () => {
    const ctx = {
      cfg: {} as any,
      accountId: "test",
      account: { joinCode: "abc" } as AccountConfig,
      abortSignal: new AbortController().signal,
      runtime: {} as any,
      getStatus: vi.fn(),
      setStatus: vi.fn(),
    };
    await expect(gateway.startAccount!(ctx as any)).rejects.toThrow("Missing joinCode or agentName");
  });

  it("startAccount registers and stores connection", async () => {
    const mockFetch = vi.fn()
      // registration call
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
      // SSE call (return a never-resolving body to keep SSE alive)
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}), // hangs forever (SSE stream)
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

    await gateway.startAccount!(ctx as any);

    // Verify registration was called
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/register",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"joinCode":"abc"'),
      }),
    );

    // Cleanup
    abortController.abort();

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

    // Should not throw even if no connection exists
    await expect(gateway.stopAccount!(ctx as any)).resolves.toBeUndefined();
  });
});
