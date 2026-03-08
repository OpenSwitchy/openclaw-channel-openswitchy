import type {
  ChannelPlugin,
  OpenClawConfig,
  AccountConfig,
  GatewayContext,
  SendTextOpts,
  RegisterResponse,
  SseNewMessageData,
  ChatHistoryMessage,
  StandardMessage,
} from "./types.js";

const DEFAULT_URL = "https://openswitchy.com";

let apiKey: string | null = null;
let agentId: string | null = null;
let baseUrl: string = DEFAULT_URL;
let sseAbort: AbortController | null = null;
let activeAccountId: string | null = null;
let onMessageCb: ((msg: StandardMessage) => void) | null = null;

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function api<T>(method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSwitchy API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

async function register(account: AccountConfig): Promise<RegisterResponse> {
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

function connectSse(): void {
  if (!apiKey || !onMessageCb) return;

  sseAbort = new AbortController();
  const url = `${baseUrl}/agent/events`;

  pollSse(url, sseAbort.signal);
}

async function pollSse(url: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });

      if (!res.ok || !res.body) {
        console.error(`[openswitchy] SSE connection failed (${res.status}), retrying in 5s`);
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
              await handleNewMessage(data);
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

async function handleNewMessage(data: SseNewMessageData): Promise<void> {
  if (!onMessageCb || !activeAccountId) return;

  // Skip own messages
  if (data.from.agentId === agentId) return;

  // Fetch the latest message from history for full content
  const history = await api<{ messages: ChatHistoryMessage[] }>(
    "GET",
    `/get_chat_history/${data.chatRoomId}?limit=1`
  );

  const latest = history.messages[history.messages.length - 1];
  if (!latest) return;

  // Check if we're mentioned
  const mentioned =
    data.mentioned === true ||
    (latest.metadata?.mentionedAgentIds || []).includes(agentId!);

  const msg: StandardMessage = {
    channel: "openswitchy",
    accountId: activeAccountId,
    chatId: data.chatRoomId,
    messageId: latest._id || data.messageId,
    from: {
      id: data.from.agentId,
      name: data.from.name,
    },
    text: latest.content,
    mentioned,
    timestamp: latest.createdAt || new Date().toISOString(),
    target: {
      chatRoomId: data.chatRoomId,
    },
  };

  onMessageCb(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Channel Plugin ── */

export const openswitchyChannel: ChannelPlugin = {
  id: "openswitchy",
  textChunkLimit: 4096,

  listAccountIds(cfg: OpenClawConfig): string[] {
    const accounts = cfg.channels?.openswitchy?.accounts;
    if (!accounts) return [];
    return Object.keys(accounts).filter((id) => {
      const acc = accounts[id];
      return acc?.enabled !== false;
    });
  },

  resolveAccount(cfg: OpenClawConfig, accountId: string): AccountConfig | undefined {
    return cfg.channels?.openswitchy?.accounts?.[accountId];
  },

  isConfigured(account: AccountConfig): boolean {
    return Boolean(account.joinCode && account.agentName);
  },

  async start(ctx: GatewayContext): Promise<void> {
    const { account, accountId, onMessage } = ctx;

    if (!account.joinCode || !account.agentName) {
      throw new Error("[openswitchy] Missing joinCode or agentName in config");
    }

    baseUrl = account.url || DEFAULT_URL;
    activeAccountId = accountId;
    onMessageCb = onMessage;

    // Register agent
    console.log(`[openswitchy] Registering agent "${account.agentName}" at ${baseUrl}`);
    const reg = await register(account);
    apiKey = reg.apiKey;
    agentId = reg.agentId;

    console.log(
      `[openswitchy] Registered as ${reg.name} (${reg.agentId}) in org "${reg.orgName}" — status: ${reg.status}`
    );

    // Connect SSE for real-time messages
    connectSse();
    console.log("[openswitchy] SSE connected, listening for messages");
  },

  async stop(): Promise<void> {
    if (sseAbort) {
      sseAbort.abort();
      sseAbort = null;
    }
    apiKey = null;
    agentId = null;
    activeAccountId = null;
    onMessageCb = null;
    console.log("[openswitchy] Disconnected");
  },

  async sendText({ text, target }: SendTextOpts): Promise<{ ok: boolean }> {
    if (!apiKey) {
      throw new Error("[openswitchy] Not connected — call start() first");
    }

    await api("POST", "/chat", {
      chatRoomId: target.chatRoomId,
      message: text,
    });

    return { ok: true };
  },

  resolveDmPolicy(account: AccountConfig): string {
    return account.dmPolicy || "open";
  },
};
