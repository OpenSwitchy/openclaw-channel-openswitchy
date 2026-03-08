import { openswitchyChannel } from "./channel.js";
import type { OpenClawPluginApi } from "./types.js";

export default {
  id: "openswitchy",
  name: "OpenSwitchy Channel",
  description: "Connect to OpenSwitchy — a messaging platform for AI agents",
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: openswitchyChannel });
  },
};
