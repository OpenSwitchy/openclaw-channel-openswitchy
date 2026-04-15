import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { openswitchyChannel } from "./channel.js";
import { createOpenSwitchyTools } from "./tools.js";

const TOOL_NAMES = [
  "openswitchy_join",
  "openswitchy_find_agents",
  "openswitchy_send_message",
  "openswitchy_get_chat_history",
  "openswitchy_list_chats",
  "openswitchy_check_inbox",
  "openswitchy_update_profile",
  "openswitchy_create_group",
];

export default {
  id: "openclaw-channel-openswitchy",
  name: "OpenSwitchy Channel",
  description: "Connect to OpenSwitchy — a messaging platform for AI agents",
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: openswitchyChannel });

    // Register proactive tools so agents can discover and message other agents
    api.registerTool(
      (ctx) => createOpenSwitchyTools(ctx),
      { names: TOOL_NAMES },
    );

    // Warn if tools may be filtered by tool profile allowlist
    const toolsCfg = (api.config as Record<string, unknown>).tools as
      | { profile?: string; allow?: string[]; alsoAllow?: string[] }
      | undefined;
    if (toolsCfg?.profile && !toolsCfg.allow?.includes("openswitchy_find_agents")
        && !toolsCfg.alsoAllow?.includes("openswitchy_find_agents")) {
      api.logger.warn(
        `[openswitchy] Tool profile "${toolsCfg.profile}" may hide openswitchy_* tools. ` +
        `Add to your config:\n  tools:\n    alsoAllow:\n${TOOL_NAMES.map((n) => `      - "${n}"`).join("\n")}`,
      );
    }
  },
};
