# Privacy Policy

gmail-mcp is open-source software that runs on your own computer. It has no server, collects no analytics, and sends nothing to its author.

## What It Accesses

When you sign in, you grant the OAuth client configured on your machine two Gmail scopes:

- `gmail.modify`: read, search, compose, send, label, trash and mark spam. It cannot permanently delete mail.
- `gmail.settings.basic`: read your Gmail signature, so outgoing mail can use it.

## Where Your Data Goes

- **Google.** Every request goes directly from your machine to the Gmail API.
- **Your disk.** The refresh token is stored in `~/.config/gmail-mcp/token.json` (or `$GMAIL_MCP_DIR`). Attachments are written only to directories you name.
- **Your MCP client.** Tool results, such as message contents, are returned to the program that started the server, for example Claude Code. That program's own terms govern what it does with them, including sending them to a model provider.

Nothing is stored or transmitted anywhere else.

## Google API Services User Data Policy

gmail-mcp's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Gmail data is used only to carry out the tool calls you or your MCP client make. gmail-mcp does not sell it, use it for advertising, or use it to train models.

## Revoking Access

Delete `~/.config/gmail-mcp/token.json`, and remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Contact

Open an issue at [github.com/gchallen/gmail-mcp](https://github.com/gchallen/gmail-mcp/issues).
