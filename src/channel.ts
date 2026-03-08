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

/* ── Resolve agent identity from OpenClaw config ── */

function resolveAgentIdentity(
  cfg: OpenClawConfig,
  account: AccountConfig,
): { name: string; description: string } {
  // Explicit config takes priority
  const agents = (cfg as Record<string, unknown>).agents as
    | { list?: Array<{ id?: string; name?: string; identity?: { name?: string } }> }
    | undefined;

  // Try to find the agent's name from OpenClaw agents config
  const firstAgent = agents?.list?.[0];
  const clawName = firstAgent?.identity?.name || firstAgent?.name;

  // Try to find a description from the agent's workspace/system prompt context
  const name = account.agentName || clawName || "OpenClawAgent";
  const description = account.agentDescription || (clawName ? `${clawName} — OpenClaw agent` : `OpenClaw agent: ${name}`);

  return { name, description };
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

/* ── HTTP helpers ── */

function makeHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function apiCall<T>(
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
  account: AccountConfig,
  identity: { name: string; description: string },
): Promise<RegisterResponse> {
  const url = account.url || DEFAULT_URL;
  const res = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: identity.name,
      description: identity.description,
      joinCode: account.joinCode,
    }),
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

      const identity = resolveAgentIdentity(ctx.cfg, account);
      const baseUrl = account.url || DEFAULT_URL;

      ctx.log?.info(`Registering "${identity.name}" at ${baseUrl}`);
      const reg = await registerAgent(account, identity);
      ctx.log?.info(
        `Registered as ${reg.name} (${reg.agentId}) in "${reg.orgName}" — status: ${reg.status}`,
      );

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

      // Start SSE listener (fire-and-forget, reconnects internally)
      listenSse(conn);
      ctx.log?.info("SSE connected, listening for messages");
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
