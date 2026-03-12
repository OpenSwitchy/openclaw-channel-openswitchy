import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock channel module before importing tools
vi.mock("./channel.js", () => ({
  getConnection: vi.fn(),
  apiCall: vi.fn(),
}));

import { createOpenSwitchyTools } from "./tools.js";
import { getConnection, apiCall } from "./channel.js";

const mockGetConnection = vi.mocked(getConnection);
const mockApiCall = vi.mocked(apiCall);

const fakeConn = {
  apiKey: "sb_test_key",
  agentId: "agent-123",
  baseUrl: "https://openswitchy.com",
  accountId: "default",
  abortController: new AbortController(),
  gatewayCtx: {} as any,
};

describe("createOpenSwitchyTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no connection exists", () => {
    mockGetConnection.mockReturnValue(undefined);
    const tools = createOpenSwitchyTools({ agentAccountId: "default" });
    expect(tools).toBeNull();
  });

  it("returns 7 tools when connected", () => {
    mockGetConnection.mockReturnValue(fakeConn as any);
    const tools = createOpenSwitchyTools({ agentAccountId: "default" });
    expect(tools).toHaveLength(7);
    const names = tools!.map((t) => t.name);
    expect(names).toEqual([
      "openswitchy_find_agents",
      "openswitchy_send_message",
      "openswitchy_get_chat_history",
      "openswitchy_list_chats",
      "openswitchy_check_inbox",
      "openswitchy_update_profile",
      "openswitchy_create_group",
    ]);
  });

  it("uses first connection when no accountId given", () => {
    mockGetConnection.mockReturnValue(fakeConn as any);
    const tools = createOpenSwitchyTools({});
    expect(tools).not.toBeNull();
    expect(mockGetConnection).toHaveBeenCalledWith("default");
  });
});

describe("openswitchy_find_agents", () => {
  beforeEach(() => {
    mockGetConnection.mockReturnValue(fakeConn as any);
  });

  it("calls GET /find_someone without query", async () => {
    mockApiCall.mockResolvedValue({ agents: [{ _id: "a1", name: "Bot1" }] });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const findTool = tools.find((t) => t.name === "openswitchy_find_agents")!;

    const result = await findTool.execute("call-1", {});
    expect(mockApiCall).toHaveBeenCalledWith(
      "https://openswitchy.com",
      "sb_test_key",
      "GET",
      "/find_someone",
    );
    expect(result.content[0]).toHaveProperty("text");
  });

  it("calls GET /find_someone?query=... with query", async () => {
    mockApiCall.mockResolvedValue({ agents: [] });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const findTool = tools.find((t) => t.name === "openswitchy_find_agents")!;

    await findTool.execute("call-1", { query: "billing" });
    expect(mockApiCall).toHaveBeenCalledWith(
      "https://openswitchy.com",
      "sb_test_key",
      "GET",
      "/find_someone?query=billing",
    );
  });
});

describe("openswitchy_send_message", () => {
  beforeEach(() => {
    mockGetConnection.mockReturnValue(fakeConn as any);
  });

  it("sends 1:1 message with 'to'", async () => {
    mockApiCall.mockResolvedValue({ chatRoomId: "room-1", messageId: "msg-1" });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const sendTool = tools.find((t) => t.name === "openswitchy_send_message")!;

    const result = await sendTool.execute("call-1", {
      message: "Hello!",
      to: "uuid-456",
    });
    expect(mockApiCall).toHaveBeenCalledWith(
      "https://openswitchy.com",
      "sb_test_key",
      "POST",
      "/chat",
      { message: "Hello!", to: "uuid-456" },
    );
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("room-1"));
  });

  it("sends to chatRoomId", async () => {
    mockApiCall.mockResolvedValue({ chatRoomId: "room-2", messageId: "msg-2" });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const sendTool = tools.find((t) => t.name === "openswitchy_send_message")!;

    await sendTool.execute("call-1", {
      message: "Hi group!",
      chatRoomId: "room-2",
    });
    expect(mockApiCall).toHaveBeenCalledWith(
      "https://openswitchy.com",
      "sb_test_key",
      "POST",
      "/chat",
      { message: "Hi group!", chatRoomId: "room-2" },
    );
  });
});

describe("openswitchy_check_inbox", () => {
  beforeEach(() => {
    mockGetConnection.mockReturnValue(fakeConn as any);
  });

  it("returns 'No unread messages' when inbox empty", async () => {
    mockApiCall.mockResolvedValue({ inbox: [] });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const inboxTool = tools.find((t) => t.name === "openswitchy_check_inbox")!;

    const result = await inboxTool.execute("call-1", {});
    expect(result.content[0]).toHaveProperty("text", "No unread messages.");
  });

  it("returns inbox data when messages exist", async () => {
    mockApiCall.mockResolvedValue({
      inbox: [{ chatRoomId: "room-1", messages: [{ content: "hey" }] }],
    });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const inboxTool = tools.find((t) => t.name === "openswitchy_check_inbox")!;

    const result = await inboxTool.execute("call-1", {});
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("room-1"));
  });
});

describe("openswitchy_list_chats", () => {
  beforeEach(() => {
    mockGetConnection.mockReturnValue(fakeConn as any);
  });

  it("returns JSON array when empty", async () => {
    mockApiCall.mockResolvedValue({ chatRooms: [] });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const listTool = tools.find((t) => t.name === "openswitchy_list_chats")!;

    const result = await listTool.execute("call-1", {});
    expect(result.content[0]).toHaveProperty("text", "[]");
  });
});

describe("openswitchy_get_chat_history", () => {
  beforeEach(() => {
    mockGetConnection.mockReturnValue(fakeConn as any);
  });

  it("fetches history without since", async () => {
    mockApiCall.mockResolvedValue({
      chatRoomId: "room-1",
      messages: [{ content: "hello" }],
    });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const historyTool = tools.find((t) => t.name === "openswitchy_get_chat_history")!;

    await historyTool.execute("call-1", { chatRoomId: "room-1" });
    expect(mockApiCall).toHaveBeenCalledWith(
      "https://openswitchy.com",
      "sb_test_key",
      "GET",
      "/get_chat_history/room-1",
    );
  });

  it("fetches history with since parameter", async () => {
    mockApiCall.mockResolvedValue({ chatRoomId: "room-1", messages: [] });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const historyTool = tools.find((t) => t.name === "openswitchy_get_chat_history")!;

    await historyTool.execute("call-1", {
      chatRoomId: "room-1",
      since: "2026-01-01T00:00:00Z",
    });
    expect(mockApiCall).toHaveBeenCalledWith(
      "https://openswitchy.com",
      "sb_test_key",
      "GET",
      "/get_chat_history/room-1?since=2026-01-01T00%3A00%3A00Z",
    );
  });
});

describe("openswitchy_create_group", () => {
  beforeEach(() => {
    mockGetConnection.mockReturnValue(fakeConn as any);
  });

  it("creates group with participants", async () => {
    mockApiCall.mockResolvedValue({
      chatRoomId: "group-1",
      name: "My Team",
      participants: [],
    });
    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const groupTool = tools.find((t) => t.name === "openswitchy_create_group")!;

    const result = await groupTool.execute("call-1", {
      participantIds: ["uuid-1", "uuid-2"],
      name: "My Team",
    });
    expect(mockApiCall).toHaveBeenCalledWith(
      "https://openswitchy.com",
      "sb_test_key",
      "POST",
      "/chat/group",
      { participantIds: ["uuid-1", "uuid-2"], name: "My Team" },
    );
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("group-1"));
  });
});

describe("tool execution errors", () => {
  it("throws when not connected during execution", async () => {
    // Factory sees a connection, but it disappears before execute
    mockGetConnection
      .mockReturnValueOnce(fakeConn as any) // for factory check
      .mockReturnValue(undefined); // for execute-time getConn

    const tools = createOpenSwitchyTools({ agentAccountId: "default" })!;
    const findTool = tools.find((t) => t.name === "openswitchy_find_agents")!;

    await expect(findTool.execute("call-1", {})).rejects.toThrow("not connected");
  });
});
