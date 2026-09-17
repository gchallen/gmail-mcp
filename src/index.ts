// Server-only entry point: `bun src/index.ts` or `node dist/index.js`.
import { runStdio } from './server.js';

runStdio().catch((e) => {
  console.error('Fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
