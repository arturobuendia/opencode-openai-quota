# Repository Instructions

## Workflow
- Commit and push directly to `master`; do not create feature branches unless the repository owner asks for one.
- Keep each commit one reviewable work unit, with the tests and docs for that behavior in the same commit.
- Never force-push, amend published commits, or rewrite history on `master`. If a change looks wrong after pushing, fix it with a new commit.

## Runtime and verification
- This is an ES module OpenCode 2 plugin package, distributed as the npm package `opencode-openai-quota`; Node.js 20 or newer is required for the development scripts.
- Run the full suite with `npm test`; run the quota tests alone with `node --test test/quota.test.mjs`.
- `npm run check` syntax-checks `src/codex.js`, `src/quota.js`, and `src/refresh.js`, then runs `npm test`. It does not need Bun or an OpenCode installation.
- `npm run probe` is the only script that touches a real `codex app-server`. Everything else must stay offline.
- Tests drive `test/fake-codex.mjs` through `process.execPath` plus injected clocks, timers, and readers. Never use real credentials, real Codex accounts, or network requests in tests.

## Architecture
- OpenCode 2 plugin package with two parts: `src/index.ts` is the server part and registers nothing, `src/tui.tsx` is the TUI part that renders and schedules. `index.ts`/`tui.tsx` at the repository root are re-export shims so the folder can be discovered as a plugin directory.
- `src/codex.js` owns the local Codex integration: spawn `codex app-server`, run the JSON-lines handshake (`initialize` → `initialized` → `account/rateLimits/read`), and tear the child down.
- `src/quota.js` owns normalization and display text. `src/refresh.js` owns the cooldown and request coalescing.

## Code boundaries and behavior
- Keep rendering, slot registration, keymap commands, and lifecycle/interval wiring in `src/tui.tsx`; process handling in `src/codex.js`; parsing and formatting in `src/quota.js`.
- The plugin has no credentials and makes no HTTP requests. Never read `auth.json` or `OPENCODE_AUTH_CONTENT`, and never log a token or raw Codex output.
- One read must not outlive itself: close stdin, keep the timeout, and kill the child if it lingers. Never let two reads start overlapping `codex` processes; route them through `src/refresh.js`.
- `usedPercent` is converted to remaining quota. Identify windows by their reported duration and show the real duration when it is not a known one; never invent a window the payload does not contain.
- Missing or malformed data renders as unavailable, never as a guessed number. Banked-reset expiration requires every available credit to carry a valid timestamp.
- On a failed read keep the previous snapshot visible and surface the error; only a first-time failure shows the bare error and the `/quota-refresh` hint.
- Disposal is mandatory: clear both intervals, clear the post-execution timer, unsubscribe from `session.execution.succeeded`, and release the sidebar slot.
- All user-visible UI copy is English; keep it consistent with the README's status table.
