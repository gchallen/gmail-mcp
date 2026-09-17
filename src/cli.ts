#!/usr/bin/env node
import { interactiveAuth, verifyToken } from './auth.js';
import { configDir, credentialsPath, tokenPath, SCOPES } from './config.js';
import { GmailService } from './gmail.js';
import { tools, toolByName } from './tools.js';
import { runStdio } from './server.js';
import * as fs from 'node:fs';
import { z } from 'zod';

const USAGE = `gmail-mcp: Gmail MCP server

  gmail-mcp                  start the MCP server on stdio (what Claude runs)
  gmail-mcp auth [--force]   sign in with Google in a browser; --force re-consents
  gmail-mcp status           show the config directory, whether a token exists, and the account
  gmail-mcp tools            list tools and their parameters
  gmail-mcp call <tool> '<json>'   run one tool from the shell, e.g.
      gmail-mcp call search_threads '{"query":"is:unread","maxResults":5}'

Config directory: ${configDir()}  (override with GMAIL_MCP_DIR)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'server':
      await runStdio();
      return;

    case 'auth': {
      const force = rest.includes('--force');
      if (!force) {
        const v = await verifyToken();
        if (v.ok) {
          console.log(`Already authenticated as ${v.email}. Use --force to re-consent.`);
          return;
        }
        if (v.error && !/Not authenticated/.test(v.error))
          console.log(`${v.error}\nRe-authenticating...`);
      }
      console.log(`Opening a browser to sign in. Scopes: ${SCOPES.join(', ')}`);
      await interactiveAuth();
      const v = await verifyToken();
      if (!v.ok) throw new Error(v.error);
      console.log(`Authenticated as ${v.email}. Token saved to ${tokenPath()}`);
      return;
    }

    case 'status': {
      console.log(`Config directory: ${configDir()}`);
      console.log(
        `OAuth client:     ${fs.existsSync(credentialsPath()) ? credentialsPath() : 'MISSING (credentials.json)'}`,
      );
      console.log(
        `Token:            ${fs.existsSync(tokenPath()) ? tokenPath() : 'MISSING (run gmail-mcp auth)'}`,
      );
      const v = await verifyToken();
      console.log(
        v.ok ? `Account:          ${v.email}` : `Account:          not available (${v.error})`,
      );
      if (v.ok) {
        const sig = await new GmailService().getSignature();
        console.log(`Signature:        ${sig ? JSON.stringify(sig.text) : 'none configured'}`);
      }
      return;
    }

    case 'tools': {
      for (const t of tools) {
        const shape = t.schema as Record<string, z.ZodTypeAny>;
        const params = Object.entries(shape)
          .map(([k, v]) => (v.isOptional() ? `${k}?` : k))
          .join(', ');
        console.log(`${t.name}(${params})\n    ${t.description}\n`);
      }
      return;
    }

    case 'call': {
      const [name, json] = rest;
      const t = name && toolByName(name);
      if (!t) throw new Error(`Unknown tool "${name}". Run \`gmail-mcp tools\`.`);
      const args = z.object(t.schema).parse(json ? JSON.parse(json) : {});
      const result = await t.handler(args, new GmailService());
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return;

    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
