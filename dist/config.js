import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
/**
 * Everything the server needs to know about where it lives and how to sign
 * outgoing mail. All of it is per-machine (a token) or per-user (a signature),
 * so it is kept out of the repository in a config directory:
 *
 *   $GMAIL_MCP_DIR, default ~/.config/gmail-mcp
 *     credentials.json  OAuth client from Google Cloud Console (Desktop app)
 *     token.json        refresh token written by `gmail-mcp auth`
 *     config.json       optional: { "signature": "...", "signatureHtml": "..." }
 *
 * Point GMAIL_MCP_DIR at a different directory to run a second account.
 */
// gmail.modify is everything except permanent deletion: read, search, drafts,
// send, labels, trash, spam. settings.basic is read so the signature Gmail
// itself is configured with can be used when no local one is set.
export const SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.settings.basic',
];
export function configDir() {
    const dir = process.env.GMAIL_MCP_DIR || path.join(os.homedir(), '.config', 'gmail-mcp');
    return dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir;
}
export const credentialsPath = () => path.join(configDir(), 'credentials.json');
export const tokenPath = () => path.join(configDir(), 'token.json');
export const configPath = () => path.join(configDir(), 'config.json');
export function loadUserConfig() {
    let cfg = {};
    try {
        cfg = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    }
    catch {
        // No config file is fine.
    }
    if (process.env.GMAIL_SIGNATURE)
        cfg.signature = process.env.GMAIL_SIGNATURE;
    if (process.env.GMAIL_SIGNATURE_HTML)
        cfg.signatureHtml = process.env.GMAIL_SIGNATURE_HTML;
    if (process.env.GMAIL_APPEND_SIGNATURE)
        cfg.appendSignature = !/^(0|false|no)$/i.test(process.env.GMAIL_APPEND_SIGNATURE);
    return cfg;
}
