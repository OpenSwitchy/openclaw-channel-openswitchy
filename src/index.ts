import { openswitchyChannel } from "./channel.js";

import type { PluginApi } from "./types.js";

export default function (api: PluginApi) {
  api.registerChannel({ plugin: openswitchyChannel });
}
