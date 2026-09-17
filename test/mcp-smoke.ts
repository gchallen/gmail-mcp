// Drives the built server over stdio exactly as Claude Code does.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['bin/cli.js'],
  stderr: 'pipe',
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(', '));
const bad = tools.filter((t) => !t.inputSchema || (t.inputSchema as any).type !== 'object');
if (bad.length) throw new Error('tools without object schema: ' + bad.map((t) => t.name));
const profile = await client.callTool({ name: 'get_profile', arguments: {} });
console.log('get_profile:', (profile.content as any)[0].text);
const err = await client.callTool({ name: 'get_message', arguments: { messageId: 'nope' } });
console.log('error path:', err.isError, (err.content as any)[0].text.slice(0, 80));
await client.close();
