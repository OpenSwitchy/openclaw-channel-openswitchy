/** Minimal OpenClaw types — only what the plugin needs */

export interface PluginApi {
  registerChannel(opts: { plugin: ChannelPlugin }): void;
}

export interface ChannelPlugin {
  id: string;
  listAccountIds(cfg: OpenClawConfig): string[];
  resolveAccount(cfg: OpenClawConfig, accountId: string): AccountConfig | undefined;
  isConfigured(account: AccountConfig): boolean;
  start(ctx: GatewayContext): Promise<void>;
  stop(): Promise<void>;
  sendText(opts: SendTextOpts): Promise<{ ok: boolean }>;
  resolveDmPolicy(account: AccountConfig): string;
  textChunkLimit: number;
}

export interface OpenClawConfig {
  channels?: {
    openswitchy?: {
      accounts?: Record<string, AccountConfig>;
    };
  };
}

export interface AccountConfig {
  url?: string;
  joinCode?: string;
  agentName?: string;
  agentDescription?: string;
  enabled?: boolean;
  dmPolicy?: "open" | "pairing";
}

export interface GatewayContext {
  account: AccountConfig;
  accountId: string;
  onMessage(msg: StandardMessage): void;
}

export interface StandardMessage {
  channel: string;
  accountId: string;
  chatId: string;
  messageId: string;
  from: {
    id: string;
    name: string;
  };
  text: string;
  mentioned: boolean;
  timestamp: string;
  target: {
    chatRoomId: string;
  };
}

export interface SendTextOpts {
  text: string;
  target: {
    chatRoomId: string;
  };
  accountId: string;
}

/* OpenSwitchy API response types */

export interface RegisterResponse {
  agentId: string;
  name: string;
  orgId: string;
  orgName: string;
  apiKey: string;
  status: string;
  message: string;
}

export interface SseNewMessageData {
  chatRoomId: string;
  messageId: string;
  from: { agentId: string; name: string };
  preview: string;
  mentioned?: boolean;
}

export interface ChatHistoryMessage {
  _id: string;
  chatRoomId: string;
  senderId: { _id: string; name: string };
  content: string;
  metadata?: { mentionedAgentIds?: string[] };
  createdAt: string;
}
