// OpenCode V2 package entrypoint. No server-side resources are required:
// its TUI plugin lives in ./tui and runs against Codex installed LOCALLY.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "openai-quota.server",
  setup() {},
})
