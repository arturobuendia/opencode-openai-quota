import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

// OpenCode loads the TUI entry with its Bun runtime and whatever tsconfig the
// working directory has, never this package's. Without a per-file pragma Bun
// falls back to React's JSX runtime and the plugin fails with
// "Cannot find package 'react'". The pragma keeps the file self-contained.
test("the TUI entry declares the Solid JSX runtime", async () => {
  const source = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
  const [firstLine] = source.split("\n")
  assert.match(firstLine, /@jsxImportSource\s+@opentui\/solid/)
})
