import { expect, test } from 'bun:test';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { tools } from './tools.js';

// A "$ref" between sibling properties (cc pointing at to) is dropped by some MCP clients,
// which then send the array as a string. Every property must carry its own inline schema.
test('tool input schemas contain no $ref', () => {
  for (const t of tools) {
    const json = JSON.stringify(zodToJsonSchema(z.object(t.schema)));
    expect({ tool: t.name, hasRef: json.includes('"$ref"') }).toEqual({
      tool: t.name,
      hasRef: false,
    });
  }
});

test('to, cc and bcc are all arrays of strings', () => {
  for (const name of ['create_draft', 'send_message', 'reply', 'forward', 'update_draft']) {
    const t = tools.find((x) => x.name === name)!;
    const props = (zodToJsonSchema(z.object(t.schema)) as any).properties;
    for (const field of ['to', 'cc', 'bcc']) {
      if (!(field in props)) continue;
      expect({ name, field, type: props[field].type, items: props[field].items?.type }).toEqual({
        name,
        field,
        type: 'array',
        items: 'string',
      });
    }
  }
});
