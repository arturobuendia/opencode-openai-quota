# Changelog

## 0.3.0 — OpenCode 2 beta

- Updated sidebar: longer progress bars, red/amber low-balance states, visual separation of banked resets, and consistent English countdown labels.
- Automatically refresh after successful session execution, after a quota window resets, and every two minutes.
- Coalesce concurrent refreshes and throttle automatic attempts to once per minute. Manual `/quota-refresh` bypasses the throttle.
- Preserve the last known quota with a clear warning if Codex temporarily fails.
- Correctly handle a Codex response containing only a weekly rate-limit window, without inventing a session window.
- Move installer backups outside `plugins/` so OpenCode does not discover duplicate copies.
- Tests added for refresh sequencing, event-safe scheduling primitives, empty/missing data and display labels.
- README rewritten around the OpenCode 2 plugin package: local Codex app-server reads, global discovery install, rewrite of the quota preview illustration.
- Windows: quote the Codex command and arguments when spawning through the shell, so executables in paths with spaces work.
- Remove the unused V1 modules and tests (`src/tui.js`, `src/auth.js`, the legacy `.test.js` suite, and the Bun host harness), and rewrite `AGENTS.md` around the OpenCode 2 architecture.
- All user-visible error messages are English, matching the rest of the panel.
- Publish to npm as `opencode-openai-quota`: install with `opencode plugin add`, a `files` whitelist so only runtime sources ship, package metadata, and a `prepublishOnly` gate that runs the suite.

## 0.2.0

- Initial OpenCode 2 sidebar panel for Codex subscription quotas.
- Local Codex app-server JSON-RPC handshake and quota read.
- Manual `/quota-refresh` and 2-minute polling.
