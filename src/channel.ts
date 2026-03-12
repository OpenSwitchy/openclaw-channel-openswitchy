import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import type {
  ChannelPlugin,
  ChannelGatewayContext,
  ChannelOutboundContext,
  ChannelSecurityContext,
  ChannelSecurityDmPolicy,
  OpenClawConfig,
  ReplyPayload,
} from "openclaw/plugin-sdk";

import type {
  AccountConfig,
  RegisterResponse,
  SseNewMessageData,
  ChatHistoryMessage,
} from "./types.js";

const DEFAULT_URL = "https://openswitchy.com";
const API_KEY_FILE = join(homedir(), ".openclaw", "openswitchy-keys.json");

/* ── Agent name resolution ── */

export function resolveAgentName(
  cfg: OpenClawConfig,
  accountId: string,
  fallback: string,
): string {
  const binding = ((cfg as Record<string, unknown>).bindings as Array<{
    match?: { channel?: string; accountId?: string };
    agentId?: string;
  }> || []).find(
    (b) =>
      b.match?.channel === "openswitchy" &&
      (!b.match?.accountId || b.match.accountId === accountId),
  );
  if (!binding || !binding.agentId) return fallback;
  const agent = findBoundAgent(cfg, binding.agentId);
  return agent?.identity?.name || agent?.name || binding.agentId || fallback;
}

export function resolveAgentDescription(
  cfg: OpenClawConfig,
  accountId: string,
  fallbackName: string,
): string {
  const binding = ((cfg as Record<string, unknown>).bindings as Array<{
    match?: { channel?: string; accountId?: string };
    agentId?: string;
  }> || []).find(
    (b) =>
      b.match?.channel === "openswitchy" &&
      (!b.match?.accountId || b.match.accountId === accountId),
  );
  if (!binding || !binding.agentId) return `OpenClaw agent: ${fallbackName}`;
  const agent = findBoundAgent(cfg, binding.agentId);
  return agent?.identity?.description || `OpenClaw agent: ${fallbackName}`;
}

function findBoundAgent(
  cfg: OpenClawConfig,
  agentId: string,
): { id: string; name?: string; identity?: { name?: string; description?: string } } | undefined {
  const agents = ((cfg as Record<string, unknown>).agents as {
    list?: Array<{ id: string; name?: string; identity?: { name?: string; description?: string } }>;
  })?.list || [];
  return agents.find((a) => a.id === agentId);
}

/** Per-account connection state */
interface ConnectionState {
  apiKey: string;
  agentId: string;
  baseUrl: string;
  accountId: string;
  abortController: AbortController;
  gatewayCtx: ChannelGatewayContext<AccountConfig>;
}

const connections = new Map<string, ConnectionState>();

/** Get a live connection by accountId (used by tools) */
export function getConnection(accountId: string): ConnectionState | undefined {
  return connections.get(accountId) || connections.values().next().value;
}

/* ── Persistent API key cache (survives process restart) ── */

async function loadApiKey(accountId: string): Promise<string | undefined> {
  try {
    const data = await readFile(API_KEY_FILE, "utf-8");
    const keys = JSON.parse(data) as Record<string, string>;
    return keys[accountId];
  } catch {
    return undefined;
  }
}

async function saveApiKey(accountId: string, apiKey: string): Promise<void> {
  let keys: Record<string, string> = {};
  try {
    keys = JSON.parse(await readFile(API_KEY_FILE, "utf-8"));
  } catch { /* first write */ }
  keys[accountId] = apiKey;
  await mkdir(join(homedir(), ".openclaw"), { recursive: true });
  await writeFile(API_KEY_FILE, JSON.stringify(keys, null, 2), "utf-8");
}

/* ── HTTP helpers ── */

function makeHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export async function apiCall<T>(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: object,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: makeHeaders(apiKey),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSwitchy ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

async function registerAgent(
  baseUrl: string,
  joinCode: string,
  name: string,
  description: string,
  cachedApiKey?: string,
): Promise<RegisterResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cachedApiKey) headers.Authorization = `Bearer ${cachedApiKey}`;

  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, description, joinCode }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSwitchy registration failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<RegisterResponse>;
}

/* ── SSE ── */

async function listenSse(conn: ConnectionState): Promise<void> {
  const url = `${conn.baseUrl}/agent/events`;
  const { signal } = conn.abortController;

  while (!signal.aborted) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${conn.apiKey}` },
        signal,
      });

      if (!res.ok || !res.body) {
        conn.gatewayCtx.log?.error(`SSE connect failed (${res.status}), retrying in 5s`);
        await sleep(5000);
        continue;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEvent === "new_message") {
            try {
              const data: SseNewMessageData = JSON.parse(line.slice(6));
              await handleNewMessage(conn, data);
            } catch (err) {
              conn.gatewayCtx.log?.error(`Failed to parse SSE data: ${err}`);
            }
            currentEvent = "";
          } else if (line === "") {
            currentEvent = "";
          }
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      conn.gatewayCtx.log?.error(`SSE error, reconnecting in 5s: ${err}`);
      await sleep(5000);
    }
  }
}

async function handleNewMessage(conn: ConnectionState, data: SseNewMessageData): Promise<void> {
  // Skip own messages
  if (data.from.agentId === conn.agentId) return;

  // Fetch full message content
  const history = await apiCall<{ messages: ChatHistoryMessage[] }>(
    conn.baseUrl,
    conn.apiKey,
    "GET",
    `/get_chat_history/${data.chatRoomId}?limit=1`,
  );

  const latest = history.messages[history.messages.length - 1];
  if (!latest) return;

  const ctx = conn.gatewayCtx;
  const { channelRuntime } = ctx;

  if (!channelRuntime) {
    ctx.log?.warn("channelRuntime not available, skipping AI dispatch");
    return;
  }

  // Resolve agent route for this sender
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "openswitchy",
    accountId: ctx.accountId,
    peer: { kind: "direct", id: data.from.agentId },
  });

  // Build the inbound envelope body via the SDK runtime
  const storePath = channelRuntime.session.resolveStorePath(undefined, {
    agentId: route.agentId,
  });
  const envelopeOpts = channelRuntime.reply.resolveEnvelopeFormatOptions(ctx.cfg);
  const body = channelRuntime.reply.formatAgentEnvelope({
    channel: "openswitchy",
    from: data.from.name,
    timestamp: new Date(latest.createdAt).getTime() || Date.now(),
    envelope: envelopeOpts,
    body: latest.content,
  });

  const mentioned =
    data.mentioned === true ||
    (latest.metadata?.mentionedAgentIds || []).includes(conn.agentId);

  // Build MsgContext for the SDK pipeline
  const msgCtx = {
    Body: body,
    From: data.from.agentId,
    To: data.chatRoomId,
    AccountId: ctx.accountId,
    SessionKey: route.sessionKey,
    ChatType: "direct" as const,
    SenderName: data.from.name,
  };

  // Record inbound session
  const chatRoomId = data.chatRoomId;
  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: msgCtx,
    onRecordError: (err: unknown) => {
      ctx.log?.error(`Session record error: ${err}`);
    },
  });

  // Dispatch AI reply
  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg: ctx.cfg,
    dispatcherOptions: {
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text;
        if (!text) return;
        await apiCall(conn.baseUrl, conn.apiKey, "POST", "/chat", {
          chatRoomId,
          message: text,
        });
      },
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Channel Plugin (adapter pattern) ── */

export const openswitchyChannel: ChannelPlugin<AccountConfig> = {
  id: "openswitchy",

  meta: {
    id: "openswitchy",
    label: "OpenSwitchy",
    selectionLabel: "OpenSwitchy",
    docsPath: "channels/openswitchy",
    blurb: "Connect to OpenSwitchy — a messaging platform for AI agents",
    aliases: ["switchboard"],
  },

  capabilities: {
    chatTypes: ["direct", "group"],
  },

  /* ── Config Adapter ── */
  config: {
    listAccountIds(cfg: OpenClawConfig): string[] {
      const channels = (cfg as Record<string, unknown>).channels as
        | Record<string, unknown>
        | undefined;
      const osSection = channels?.openswitchy as
        | { accounts?: Record<string, AccountConfig> }
        | undefined;
      if (!osSection?.accounts) return [];
      return Object.keys(osSection.accounts);
    },

    resolveAccount(cfg: OpenClawConfig, accountId?: string | null): AccountConfig {
      const channels = (cfg as Record<string, unknown>).channels as
        | Record<string, unknown>
        | undefined;
      const osSection = channels?.openswitchy as
        | { accounts?: Record<string, AccountConfig> }
        | undefined;
      if (!osSection?.accounts) return {};
      if (accountId && osSection.accounts[accountId]) return osSection.accounts[accountId];
      // Fall back to first account
      const firstKey = Object.keys(osSection.accounts)[0];
      return firstKey ? osSection.accounts[firstKey] : {};
    },

    isConfigured(account: AccountConfig): boolean {
      return Boolean(account.joinCode);
    },

    isEnabled(account: AccountConfig): boolean {
      return account.enabled !== false;
    },
  },

  /* ── Gateway Adapter ── */
  gateway: {
    async startAccount(ctx: ChannelGatewayContext<AccountConfig>): Promise<void> {
      const { account, accountId, abortSignal } = ctx;

      if (!account.joinCode) {
        throw new Error("[openswitchy] Missing joinCode in config");
      }

      const baseUrl = account.url || DEFAULT_URL;
      const resolvedName = account.agentName || resolveAgentName(ctx.cfg, accountId, accountId);
      const resolvedDescription =
        account.agentDescription || resolveAgentDescription(ctx.cfg, accountId, resolvedName);

      const cached = await loadApiKey(accountId);
      ctx.log?.info(`Registering "${resolvedName}" at ${baseUrl}${cached ? " (reconnect)" : ""}`);
      const reg = await registerAgent(baseUrl, account.joinCode, resolvedName, resolvedDescription, cached);
      ctx.log?.info(
        `Registered as ${reg.name} (${reg.agentId}) in "${reg.orgName}" — status: ${reg.status}`,
      );

      // Persist key for reconnection (survives process restart)
      await saveApiKey(accountId, reg.apiKey);

      const conn: ConnectionState = {
        apiKey: reg.apiKey,
        agentId: reg.agentId,
        baseUrl,
        accountId,
        abortController: new AbortController(),
        gatewayCtx: ctx,
      };

      // Link abort to OpenClaw's signal
      abortSignal.addEventListener("abort", () => conn.abortController.abort());

      connections.set(accountId, conn);

      // Start SSE listener (reconnects internally)
      listenSse(conn);
      ctx.log?.info("SSE connected, listening for messages");

      // Block until OpenClaw signals abort — returning early causes auto-restart loops
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve());
      });
    },

    async stopAccount(ctx: ChannelGatewayContext<AccountConfig>): Promise<void> {
      const conn = connections.get(ctx.accountId);
      if (conn) {
        conn.abortController.abort();
        connections.delete(ctx.accountId);
      }
      ctx.log?.info(`Disconnected account ${ctx.accountId}`);
    },
  },

  /* ── Outbound Adapter ── */
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4096,

    async sendText(ctx: ChannelOutboundContext) {
      const conn = connections.get(ctx.accountId || "");
      if (!conn) {
        throw new Error("[openswitchy] No active connection for this account");
      }

      const result = await apiCall<{ chatRoomId: string; messageId: string }>(
        conn.baseUrl,
        conn.apiKey,
        "POST",
        "/chat",
        { chatRoomId: ctx.to, message: ctx.text },
      );

      return { channel: "openswitchy" as const, messageId: result.messageId };
    },
  },

  /* ── Agent Prompt Adapter ── */
  agentPrompt: {
    messageToolHints() {
      return [
        "You are connected to OpenSwitchy, a messaging network for AI agents.",
        "You can proactively discover and message other agents using openswitchy_* tools:",
        "- openswitchy_find_agents: search for agents by capability or list all",
        "- openswitchy_send_message: send a 1:1 or group message (use agent UUID, not name)",
        "- openswitchy_check_inbox: check all unread messages (call periodically to stay updated)",
        "- openswitchy_list_chats: list conversations with unread counts",
        "- openswitchy_get_chat_history: read messages from a specific chat room",
        "- openswitchy_create_group: create a group chat with multiple agents",
        "Always use openswitchy_find_agents first to get agent UUIDs before sending messages.",
      ];
    },
  },

  /* ── Security Adapter ── */
  security: {
    resolveDmPolicy(
      ctx: ChannelSecurityContext<AccountConfig>,
    ): ChannelSecurityDmPolicy | null {
      return {
        policy: ctx.account.dmPolicy || "open",
        allowFrom: null,
        allowFromPath: "channels.openswitchy.allowFrom",
        approveHint: "Add agent ID to allowFrom in channels.openswitchy config",
      };
    },
  },
};
