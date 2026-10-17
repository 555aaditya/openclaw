import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  browserPluginNodeHostCommands,
  browserPluginReload,
  registerBrowserPlugin,
} from "./plugin-registration.js";

export default definePluginEntry({
  id: "browser",
  name: "Browser",
  description: "Default browser tool plugin",
  reload: browserPluginReload,
  nodeHostCommands: browserPluginNodeHostCommands,
  register: registerBrowserPlugin,
});
