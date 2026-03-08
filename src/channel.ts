import type {
  ChannelPlugin,
  AccountConfig,
  OpenClawConfig,
  ChannelGatewayContext,
  ChannelOutboundContext,
  ChannelSecurityContext,
  RegisterResponse,
  SseNewMessageData,
  ChatHistoryMessage,
  InboundEnvelope,
} from "./types.js";

const DEFAULT_URL = "https://openswitchy.com";

/** Per-account connection state */
interface ConnectionState {
  apiKey: string;
  agentId: string;
  baseUrl: string;
  accountId: string;
  abortController: AbortController;
  dispatchInbound: (envelope: InboundEnvelope) => void;
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

async function registerAgent(account: AccountConfig): Promise<RegisterResponse> {
  const url = account.url || DEFAULT_URL;
  const res = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: account.agentName,
      description: account.agentDescription || `OpenClaw agent: ${account.agentName}`,
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
        console.error(`[openswitchy] SSE connect failed (${res.status}), retrying in 5s`);
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
              console.error("[openswitchy] Failed to parse SSE data:", err);
            }
            currentEvent = "";
          } else if (line === "") {
            currentEvent = "";
          }
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      console.error("[openswitchy] SSE error, reconnecting in 5s:", err);
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

  const mentioned =
    data.mentioned === true ||
    (latest.metadata?.mentionedAgentIds || []).includes(conn.agentId);

  const envelope: InboundEnvelope = {
    channel: "openswitchy",
    accountId: conn.accountId,
    from: data.from.agentId,
    to: data.chatRoomId,
    body: latest.content,
    timestamp: new Date(latest.createdAt).getTime() || Date.now(),
    metadata: {
      messageId: latest._id || data.messageId,
      fromName: data.from.name,
      chatRoomId: data.chatRoomId,
      mentioned,
    },
  };

  conn.dispatchInbound(envelope);
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
      const accounts = cfg.channels?.openswitchy?.accounts;
      if (!accounts) return [];
      return Object.keys(accounts);
    },

    resolveAccount(cfg: OpenClawConfig, accountId?: string | null): AccountConfig {
      const accounts = cfg.channels?.openswitchy?.accounts;
      if (!accounts) return {};
      if (accountId && accounts[accountId]) return accounts[accountId];
      // Fall back to first account
      const firstKey = Object.keys(accounts)[0];
      return firstKey ? accounts[firstKey] : {};
    },

    isConfigured(account: AccountConfig): boolean {
      return Boolean(account.joinCode && account.agentName);
    },

    isEnabled(account: AccountConfig): boolean {
      return account.enabled !== false;
    },
  },

  /* ── Gateway Adapter ── */
  gateway: {
    async startAccount(ctx: ChannelGatewayContext<AccountConfig>): Promise<void> {
      const { account, accountId, abortSignal } = ctx;

      if (!account.joinCode || !account.agentName) {
        throw new Error("[openswitchy] Missing joinCode or agentName in config");
      }

      const baseUrl = account.url || DEFAULT_URL;

      console.log(`[openswitchy] Registering "${account.agentName}" at ${baseUrl}`);
      const reg = await registerAgent(account);
      console.log(
        `[openswitchy] Registered as ${reg.name} (${reg.agentId}) in "${reg.orgName}" — status: ${reg.status}`,
      );

      const conn: ConnectionState = {
        apiKey: reg.apiKey,
        agentId: reg.agentId,
        baseUrl,
        accountId,
        abortController: new AbortController(),
        dispatchInbound: (envelope) => {
          ctx.channelRuntime?.reply.dispatchInbound(envelope);
        },
      };

      // Link abort to OpenClaw's signal
      abortSignal.addEventListener("abort", () => conn.abortController.abort());

      connections.set(accountId, conn);

      // Start SSE listener (fire-and-forget, reconnects internally)
      listenSse(conn);
      console.log("[openswitchy] SSE connected, listening for messages");
    },

    async stopAccount(ctx: ChannelGatewayContext<AccountConfig>): Promise<void> {
      const conn = connections.get(ctx.accountId);
      if (conn) {
        conn.abortController.abort();
        connections.delete(ctx.accountId);
      }
      console.log(`[openswitchy] Disconnected account ${ctx.accountId}`);
    },
  },

  /* ── Outbound Adapter ── */
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4096,

    async sendText(ctx: ChannelOutboundContext): Promise<{ messageId?: string }> {
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

      return { messageId: result.messageId };
    },
  },

  /* ── Security Adapter ── */
  security: {
    resolveDmPolicy(ctx: ChannelSecurityContext<AccountConfig>) {
      return {
        policy: ctx.account.dmPolicy || "open",
        allowFrom: null,
        allowFromPath: "channels.openswitchy.allowFrom",
        approveHint: "Add agent ID to allowFrom in channels.openswitchy config",
      };
    },
  },
};
