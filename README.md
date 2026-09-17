# gmail-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for one Gmail account, built for Claude Code. It talks to the Gmail API directly with a locally stored OAuth token, so it runs on any machine you sign in on and needs no hosted connector.

It is a superset of Google's hosted Gmail MCP server (`gmailmcp.googleapis.com`, the one behind the claude.ai Gmail connector): every tool there has a counterpart here with the same name and parameters, plus the things that server cannot do because it lives in the cloud.

## What it adds over the official server

- **Attachments from local files.** `create_draft`, `send_message`, `reply` and `forward` take file paths. The official server only accepts base64 in the tool call, which is unusable for a multi‑megabyte PDF.
- **Attachment download.** `list_attachments` and `save_attachments` write files to a directory of your choice.
- **A signature that survives.** The configured signature (or the one in your Gmail settings) is appended to every outgoing message as a real hyperlink, once, even if the caller typed it.
- **Drafts you can iterate on.** `update_draft` keeps existing attachments and threading unless told otherwise; `delete_draft` and `send_draft` exist.
- **Replies and forwards as drafts.** `reply` and `forward` compute Gmail's default recipients, quote the original, re‑attach forwarded files, and take `asDraft: true` when the user should review before sending.
- **Message-level search** (`search_messages`) next to thread search, `get_profile`, `get_label` with counts, `update_thread_labels`, and `batch_modify_messages` for query-driven bulk triage.
- **Labels by name.** Every label parameter accepts a label ID or its exact name.
- **A CLI.** `gmail-mcp call <tool> '<json>'` runs any tool from a shell, handy for scripts and debugging.

Bodies are plain text by default (one line per paragraph; Gmail links bare URLs on display). Pass `htmlBody` for lists or other formatting; the plain-text alternative is derived automatically.

## Setup

### 1. Create an OAuth client (once, reusable on every machine)

1. In [Google Cloud Console](https://console.cloud.google.com/) create or pick a project.
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **Google Auth Platform → Get started**: fill in the app name and your email, choose **External**.
4. **Data Access → Add or remove scopes**: add `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.settings.basic`.
5. **Audience**: add yourself under **Test users**.
6. **Clients → Create client**, type **Desktop app**. Download the JSON and save it as `~/.config/gmail-mcp/credentials.json`.
7. **Publish the app** (recommended). While the app is in Testing, Google expires refresh tokens after 7 days and you would have to run `auth` weekly. Under **Branding**, set the home page to `https://github.com/gchallen/gmail-mcp`, the privacy policy to `https://github.com/gchallen/gmail-mcp/blob/main/PRIVACY.md`, and add `github.com` as an authorized domain. Then **Audience → Publish app**. Verification is not needed for personal use: sign-in shows a "Google hasn't verified this app" warning you click through under **Advanced**, and unverified apps are limited to 100 users.

The scopes requested are `gmail.modify` (everything except permanent deletion) and `gmail.settings.basic` (to read your signature).

### 2. Install and sign in

From a clone:

```bash
git clone https://github.com/gchallen/gmail-mcp.git ~/code/gmail-mcp
cd ~/code/gmail-mcp
bun install          # or npm install
bun src/cli.ts auth  # opens a browser; writes ~/.config/gmail-mcp/token.json
bun src/cli.ts status
```

Or without cloning (the built `dist/` is committed):

```bash
bunx --bun gchallen/gmail-mcp auth
# or
npx gchallen/gmail-mcp auth
```

`token.json` holds a refresh token tied to your OAuth client. To set up a second machine, either run `auth` there or copy `~/.config/gmail-mcp/` across; both files are secrets, keep them out of git.

### 3. Register with Claude Code

```bash
claude mcp add --scope user gmail -- node ~/code/gmail-mcp/bin/cli.js
# or, with no clone on the machine:
claude mcp add --scope user gmail -- npx -y gchallen/gmail-mcp
```

Equivalent `~/.claude.json` entry:

```json
"gmail": { "type": "stdio", "command": "node", "args": ["/Users/you/code/gmail-mcp/bin/cli.js"] }
```

### 4. Turn off the claude.ai Gmail connector (optional)

If your claude.ai account has the Gmail connector attached, Claude Code loads it in every session alongside this server. Its tools have the same names, which is confusing. `claude mcp remove` cannot touch account connectors, and the `/mcp` menu only disables them per project. To block it for every project on the machine, add this to `~/.claude/settings.json`:

```json
"deniedMcpServers": [{ "serverName": "claude.ai Gmail" }]
```

The connector stays attached to your claude.ai account and keeps working there; only Claude Code on this machine stops loading it.

## Configuration

Everything lives in `~/.config/gmail-mcp/` (override the directory with `GMAIL_MCP_DIR`, which is also how you run a second account).

| File | Purpose |
| --- | --- |
| `credentials.json` | OAuth client from Google Cloud Console |
| `token.json` | Refresh token written by `gmail-mcp auth` |
| `config.json` | Optional: `{ "signature": "Name // https://example.com", "signatureHtml": "...", "appendSignature": true }` |

Signature precedence: `GMAIL_SIGNATURE` / `GMAIL_SIGNATURE_HTML` environment variables, then `config.json`, then the signature configured in Gmail settings for your primary address, then none. Set `appendSignature: false` (or `GMAIL_APPEND_SIGNATURE=false`) to disable. Any tool that composes mail also takes `signature: false` per call.

## CLI

```
gmail-mcp                       start the MCP server on stdio
gmail-mcp auth [--force]        sign in; --force re-consents (needed after a scope change)
gmail-mcp status                config dir, token state, account, signature in use
gmail-mcp tools                 list tools and parameters
gmail-mcp call <tool> '<json>'  run one tool, e.g.
    gmail-mcp call search_threads '{"query":"is:unread newer_than:2d","maxResults":5}'
    gmail-mcp call save_attachments '{"messageId":"18f...","directory":"~/Downloads/x"}'
```

## Tools

Reading: `get_profile`, `search_threads`, `search_messages`, `get_message`, `get_thread`, `list_attachments`, `save_attachments`

Drafts: `create_draft`, `update_draft`, `get_draft`, `list_drafts`, `delete_draft`, `send_draft`

Sending: `send_message`, `reply`, `forward`

Labels: `list_labels`, `get_label`, `create_label`, `update_label`, `delete_label`, `label_message`, `unlabel_message`, `update_message_labels`, `label_thread`, `unlabel_thread`, `update_thread_labels`, `batch_modify_messages`

Trash and spam: `trash_message`, `untrash_message`, `trash_thread`, `untrash_thread`, `mark_message_spam`, `unmark_message_spam`, `mark_thread_spam`, `unmark_thread_spam`, and the official server's `apply_sensitive_message_label` / `apply_sensitive_thread_label` aliases.

Message `format` values: `plain_text` (default), `full` (adds `htmlBody`), `minimal`, `metadata`, `raw`.

Search queries use Gmail's own syntax (`from:`, `subject:`, `newer_than:7d`, `has:attachment`, `label:`, `in:`, `is:unread`, quotes, `OR`, `-`).

## Development

```bash
bun test              # unit tests for MIME building, signatures, parsing
bun run typecheck
bun run build         # emits dist/ (committed so npx/bunx work from GitHub)
bun test/mcp-smoke.ts # drives the built server over stdio like a real client
```

## Comparison with the claude.ai Gmail connector

| | Official (hosted) | gmail-mcp |
| --- | --- | --- |
| Runs | Google's servers, via claude.ai connector auth | Locally, any machine with `token.json` |
| Attachments out | base64 in the tool call only | Local file paths (or base64) |
| Attachments in | Metadata only | Download to disk |
| Signature | None | Appended, hyperlinked, de-duplicated |
| Update draft | Drops attachments | Keeps them unless replaced |
| Delete draft | No | Yes |
| Reply / forward | Send only | Send or draft; forwards carry attachments |
| Bulk label changes | No | `batch_modify_messages` by IDs or query |
| Labels by name | No (IDs only) | IDs or names |
| CLI | No | Yes |

## License

MIT
