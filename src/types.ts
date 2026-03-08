/**
 * OpenClaw plugin types — matches the real adapter pattern from openclaw SDK.
 * Only includes what this plugin needs.
 */

/* ── Plugin API ── */

export interface OpenClawPluginApi {
  id: string;
  name: string;
  config: OpenClawConfig;
  logger: PluginLogger;
  registerChannel(registration: { plugin: ChannelPlugin }): void;
}

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/* ── Channel Plugin (adapter pattern) ── */

export type ChatType = "direct" | "group";

export interface ChannelPlugin<ResolvedAccount = unknown> {
  id: string;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter<ResolvedAccount>;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  outbound?: ChannelOutboundAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
}

export interface ChannelMeta {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  aliases?: string[];
}

export interface ChannelCapabilities {
  chatTypes: ChatType[];
  media?: boolean;
  reactions?: boolean;
  threads?: boolean;
}

/* ── Config Adapter ── */

export interface ChannelConfigAdapter<ResolvedAccount> {
  listAccountIds(cfg: OpenClawConfig): string[];
  resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount;
  isConfigured?(account: ResolvedAccount, cfg: OpenClawConfig): boolean;
  isEnabled?(account: ResolvedAccount, cfg: OpenClawConfig): boolean;
}

/* ── Gateway Adapter ── */

export interface ChannelGatewayAdapter<ResolvedAccount> {
  startAccount?(ctx: ChannelGatewayContext<ResolvedAccount>): Promise<unknown>;
  stopAccount?(ctx: ChannelGatewayContext<ResolvedAccount>): Promise<void>;
}

export interface ChannelGatewayContext<ResolvedAccount> {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  abortSignal: AbortSignal;
  log?: { info(msg: string): void; error(msg: string): void };
  channelRuntime?: PluginChannelRuntime;
}

export interface PluginChannelRuntime {
  reply: {
    dispatchInbound(envelope: InboundEnvelope): void;
  };
}

export interface InboundEnvelope {
  channel: string;
  accountId: string;
  from: string;
  to: string;
  body: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/* ── Outbound Adapter ── */

export interface ChannelOutboundAdapter {
  deliveryMode: "direct" | "gateway" | "hybrid";
  textChunkLimit?: number;
  sendText?(ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult>;
}

export interface ChannelOutboundContext {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
}

export interface OutboundDeliveryResult {
  messageId?: string;
}

/* ── Security Adapter ── */

export interface ChannelSecurityAdapter<ResolvedAccount> {
  resolveDmPolicy?(ctx: ChannelSecurityContext<ResolvedAccount>): ChannelSecurityDmPolicy | null;
}

export interface ChannelSecurityContext<ResolvedAccount> {
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedAccount;
}

export interface ChannelSecurityDmPolicy {
  policy: string;
  allowFrom?: Array<string | number> | null;
  allowFromPath: string;
  approveHint: string;
}

/* ── Config Shape ── */

export interface OpenClawConfig {
  channels?: {
    openswitchy?: {
      accounts?: Record<string, AccountConfig>;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AccountConfig {
  url?: string;
  joinCode?: string;
  agentName?: string;
  agentDescription?: string;
  enabled?: boolean;
  dmPolicy?: "open" | "pairing";
}

/* ── OpenSwitchy API response types ── */

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
