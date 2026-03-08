/**
 * OpenSwitchy-specific types for the channel plugin.
 *
 * OpenClaw SDK types (ChannelPlugin, OpenClawPluginApi, etc.) are imported
 * directly from "openclaw/plugin-sdk" — only OpenSwitchy API shapes live here.
 */

/* ── Plugin account config ── */

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
