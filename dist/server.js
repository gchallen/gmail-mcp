import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GmailService } from './gmail.js';
import { tools } from './tools.js';
import { explainError } from './auth.js';
import { createRequire } from 'node:module';
const pkg = createRequire(import.meta.url)('../package.json');
export const SERVER_INSTRUCTIONS = 'Gmail for one account. Read with search_threads / search_messages, then get_thread or get_message (default ' +
    'format plain_text keeps context small). Compose with create_draft (review first) or send_message / reply / forward ' +
    '(send now; asDraft on reply and forward makes a draft). Bodies are plain text, one line per paragraph, no Markdown; ' +
    'use htmlBody for lists. Never type a signature or sign-off: the configured signature is appended automatically. ' +
    'Attachments are local file paths. Subjects in Title Case. Label tools accept label IDs or exact names.';
export function createServer() {
    const server = new McpServer({ name: 'gmail-mcp', version: pkg.version }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
    const gmail = new GmailService();
    for (const t of tools) {
        server.registerTool(t.name, {
            description: t.description,
            inputSchema: t.schema,
            annotations: {
                readOnlyHint: !!t.readOnly,
                destructiveHint: !!t.destructive,
                openWorldHint: true,
            },
        }, async (args) => {
            try {
                const result = await t.handler(args, gmail);
                return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
            }
            catch (e) {
                return {
                    content: [{ type: 'text', text: `Error: ${explainError(e)}` }],
                    isError: true,
                };
            }
        });
    }
    return server;
}
export async function runStdio() {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    console.error(`gmail-mcp ${pkg.version} running on stdio`);
}
