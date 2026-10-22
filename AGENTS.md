# Repository Instructions

## Runtime and verification
- This is a private ES module package; Node.js 20 or newer is required.
- Run the full suite with `npm test`; run the quota tests alone with `node --test test/quota.test.js`.
- `npm run check` syntax-checks the three source modules and runs the Bun host harness; it needs Bun and OpenCode TUI packages resolvable from OpenCode's config directory.
- Tests use synthetic credentials and injected file reads, fetches, and timers. Keep tests offline; do not use real credentials or network requests.

## Code boundaries and behavior
- Keep OpenCode rendering, registration, and lifecycle wiring in `src/tui.js`; credential and HTTP handling in `src/auth.js`; quota parsing, controller, and formatting in `src/quota.js`.
- A non-empty valid `OPENCODE_AUTH_CONTENT` snapshot takes precedence even when it contains no OpenAI credential; empty or malformed snapshots fall back to the auth file.
- Never expose OAuth tokens in snapshots or errors. Usage requests must stay pinned to the configured HTTPS endpoint, reject redirects, and omit cookies.
- The API's `used_percent` is converted to remaining quota. Identify windows by supported durations; do not guess when an explicit duration is unknown.
- On transient refresh failures, preserve the last good quota as `stale`; expired OAuth clears it. Disposal aborts active work and clears controller timers.
