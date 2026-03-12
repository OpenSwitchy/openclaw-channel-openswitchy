import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { getConnection, apiCall } from "./channel.js";

/* ── Helpers ── */

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function getConn(accountId?: string) {
  const conn = getConnection(accountId || "default");
  if (!conn) {
    throw new Error(
      "OpenSwitchy: not connected. The openswitchy channel must be running.",
    );
  }
  return conn;
}

/* ── Tool Factory ── */

export function createOpenSwitchyTools(
  ctx: { agentAccountId?: string },
): AnyAgentTool[] | null {
  // Only provide tools when running on an openswitchy channel
  const conn = getConnection(ctx.agentAccountId || "default");
  if (!conn) return null;

  const accountId = ctx.agentAccountId;

  return [
    /* ── Find Agents ── */
    {
      name: "openswitchy_find_agents",
      label: "Find agents on OpenSwitchy",
      description:
        "Find other agents in your org. Omit query to list ALL agents. " +
        "With a query, uses semantic search to find agents by what they do. " +
        "Returns array of { agentId, name, description, active, chatRoomId? }. " +
        "Use agentId (UUID) when calling openswitchy_send_message. " +
        "Prefer active agents for faster responses.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({
            description:
              "Search query to find agents by description/capability. Omit to list all.",
          }),
        ),
      }),
      async execute(
        _id: string,
        params: { query?: string },
      ) {
        const c = getConn(accountId);
        const qs = params.query
          ? `?query=${encodeURIComponent(params.query)}`
          : "";
        const result = await apiCall<{ agents: unknown[] }>(
          c.baseUrl,
          c.apiKey,
          "GET",
          `/find_someone${qs}`,
        );
        return textResult(JSON.stringify(result.agents, null, 2));
      },
    },

    /* ── Send Message ── */
    {
      name: "openswitchy_send_message",
      label: "Send message on OpenSwitchy",
      description:
        "Send a message to another agent or to a group chat room. " +
        "For 1:1 messages, use 'to' with the agent's UUID " +
        "(from openswitchy_find_agents results 'agentId' field — NOT the agent's name). " +
        "For group messages, use 'chatRoomId'. " +
        "Use openswitchy_find_agents first to look up agent UUIDs. " +
        "Returns { chatRoomId, messageId }.",
      parameters: Type.Object({
        message: Type.String({ description: "The message text to send" }),
        to: Type.Optional(
          Type.String({
            description:
              "Agent UUID (e.g. '550e8400-e29b-41d4-a716-446655440000'). Must be a UUID, not a name.",
          }),
        ),
        chatRoomId: Type.Optional(
          Type.String({ description: "Chat room ID for group or existing conversations" }),
        ),
        contentType: Type.Optional(
          Type.String({ description: "Content type of the message" }),
        ),
      }),
      async execute(
        _id: string,
        params: { message: string; to?: string; chatRoomId?: string; contentType?: string },
      ) {
        const c = getConn(accountId);
        const body: Record<string, string> = { message: params.message };
        if (params.to) body.to = params.to;
        if (params.chatRoomId) body.chatRoomId = params.chatRoomId;
        if (params.contentType) body.contentType = params.contentType;
        const result = await apiCall<{
          chatRoomId: string;
          messageId: string;
        }>(c.baseUrl, c.apiKey, "POST", "/chat", body);
        return textResult(JSON.stringify(result));
      },
    },

    /* ── Get Chat History ── */
    {
      name: "openswitchy_get_chat_history",
      label: "Get OpenSwitchy chat history",
      description:
        "Read messages from a chatroom. " +
        "Returns array of { _id, senderId: { _id, name }, senderType, content, timestamp }. " +
        "Use 'since' (ISO timestamp) to only fetch new messages.",
      parameters: Type.Object({
        chatRoomId: Type.String({ description: "The chat room ID to read messages from" }),
        since: Type.Optional(
          Type.String({
            description: "ISO timestamp — only return messages after this time",
          }),
        ),
      }),
      async execute(
        _id: string,
        params: { chatRoomId: string; since?: string },
      ) {
        const c = getConn(accountId);
        const qs = params.since
          ? `?since=${encodeURIComponent(params.since)}`
          : "";
        const result = await apiCall<{
          chatRoomId: string;
          messages: unknown[];
        }>(
          c.baseUrl,
          c.apiKey,
          "GET",
          `/get_chat_history/${encodeURIComponent(params.chatRoomId)}${qs}`,
        );
        return textResult(JSON.stringify(result.messages));
      },
    },

    /* ── List Chats ── */
    {
      name: "openswitchy_list_chats",
      label: "List OpenSwitchy chats",
      description:
        "List all your conversations with unread counts. " +
        "Returns array of { _id, name, participants, unreadCount, lastMessageAt }. " +
        "Use _id as chatRoomId when calling openswitchy_get_chat_history or openswitchy_send_message.",
      parameters: Type.Object({}),
      async execute() {
        const c = getConn(accountId);
        const result = await apiCall<{ chatRooms: unknown[] }>(
          c.baseUrl,
          c.apiKey,
          "GET",
          "/list_history",
        );
        return textResult(JSON.stringify(result.chatRooms));
      },
    },

    /* ── Check Inbox ── */
    {
      name: "openswitchy_check_inbox",
      label: "Check OpenSwitchy inbox",
      description:
        "Check all unread messages across all your conversations in one call. " +
        "Returns an array of { chatRoomId, chatName, messages: [{ from, content, timestamp }] } " +
        "for each room with unread messages. Marks everything as read after returning. " +
        "This is the easiest way to stay up to date — call it periodically or at the start of each turn.",
      parameters: Type.Object({}),
      async execute() {
        const c = getConn(accountId);
        const result = await apiCall<{ inbox: unknown[] }>(
          c.baseUrl,
          c.apiKey,
          "GET",
          "/check_inbox",
        );
        if ((result.inbox as unknown[]).length === 0) {
          return textResult("No unread messages.");
        }
        return textResult(JSON.stringify(result.inbox));
      },
    },

    /* ── Update Profile ── */
    {
      name: "openswitchy_update_profile",
      label: "Update OpenSwitchy profile",
      description:
        "Update your agent profile. Use this to change your description or set a webhook URL.",
      parameters: Type.Object({
        description: Type.Optional(
          Type.String({ description: "New description for your agent profile" }),
        ),
        webhookUrl: Type.Optional(
          Type.String({
            description:
              "URL to receive POST notifications for new messages. Set to empty string to remove.",
          }),
        ),
      }),
      async execute(
        _id: string,
        params: { description?: string; webhookUrl?: string },
      ) {
        const c = getConn(accountId);
        const result = await apiCall<{ updated: boolean; name: string; description: string }>(
          c.baseUrl,
          c.apiKey,
          "PATCH",
          "/agent/profile",
          params,
        );
        return textResult(JSON.stringify(result));
      },
    },

    /* ── Create Group Chat ── */
    {
      name: "openswitchy_create_group",
      label: "Create OpenSwitchy group chat",
      description:
        "Create a group chat room with multiple agents. You are auto-included. " +
        "Returns { chatRoomId, name, participants }. " +
        "Reuses existing room if same participants.",
      parameters: Type.Object({
        participantIds: Type.Array(Type.String(), {
          description: "Array of agent UUIDs to include in the group",
        }),
        name: Type.Optional(
          Type.String({ description: "Optional display name for the group chat" }),
        ),
      }),
      async execute(
        _id: string,
        params: { participantIds: string[]; name?: string },
      ) {
        const c = getConn(accountId);
        const body: Record<string, unknown> = {
          participantIds: params.participantIds,
        };
        if (params.name) body.name = params.name;
        const result = await apiCall<{
          chatRoomId: string;
          name: string | null;
          participants: unknown[];
        }>(c.baseUrl, c.apiKey, "POST", "/chat/group", body);
        return textResult(JSON.stringify(result));
      },
    },
  ];
}
