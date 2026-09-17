#!/usr/bin/env node
// Thin launcher so `npx gchallen/gmail-mcp` and `bunx --bun gchallen/gmail-mcp`
// both work from a git checkout: dist/ is committed.
import('../dist/cli.js').catch((e) => {
  console.error(e);
  process.exit(1);
});
