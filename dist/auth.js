import * as fs from 'node:fs';
import { google } from 'googleapis';
import { authenticate } from '@google-cloud/local-auth';
import { SCOPES, configDir, credentialsPath, tokenPath } from './config.js';
// Note for MCP stdio servers: never write to stdout outside JSON-RPC. All
// diagnostics here go to stderr.
function loadSavedToken() {
    try {
        const json = JSON.parse(fs.readFileSync(tokenPath(), 'utf-8'));
        if (!json.refresh_token)
            return null;
        return google.auth.fromJSON(json);
    }
    catch {
        return null;
    }
}
function saveToken(client) {
    const keys = JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8'));
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    }, null, 2);
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(tokenPath(), payload, { mode: 0o600 });
}
/**
 * Interactive OAuth: opens a browser, waits on a localhost redirect, stores the
 * refresh token. Only ever run from the `auth` CLI command, never from the
 * server (which has no user in front of it).
 */
export async function interactiveAuth() {
    if (!fs.existsSync(credentialsPath())) {
        throw new Error(`No OAuth client at ${credentialsPath()}. Download a "Desktop app" OAuth client JSON from ` +
            `Google Cloud Console (APIs & Services > Credentials) and save it there. See README.md.`);
    }
    const auth = await authenticate({ scopes: SCOPES, keyfilePath: credentialsPath() });
    if (!auth.credentials?.refresh_token) {
        throw new Error('Google did not return a refresh token; revoke the app at myaccount.google.com/permissions and retry.');
    }
    saveToken(auth);
}
let cachedClient = null;
/** Gmail client from the stored refresh token. Throws a clear error if none. */
export function gmailClient() {
    if (cachedClient)
        return cachedClient;
    const auth = loadSavedToken();
    if (!auth) {
        throw new Error(`Not authenticated: no usable token at ${tokenPath()}. Run \`gmail-mcp auth\` on this machine ` +
            `(or copy a token.json from another machine into ${configDir()}).`);
    }
    cachedClient = google.gmail({ version: 'v1', auth: auth });
    return cachedClient;
}
/** Translate the common Google auth failures into something actionable. */
export function explainError(e) {
    const err = e;
    const msg = err?.message || String(e);
    if (/invalid_grant/.test(msg)) {
        return `Token rejected (invalid_grant): it was revoked or expired. Run \`gmail-mcp auth --force\` to re-consent.`;
    }
    if (/insufficient.*scope|Insufficient Permission/i.test(msg)) {
        return `Token lacks a required scope. Run \`gmail-mcp auth --force\` to re-consent to: ${SCOPES.join(', ')}.`;
    }
    return err?.errors?.[0]?.message ? `${msg}: ${err.errors[0].message}` : msg;
}
export async function verifyToken() {
    try {
        const gmail = gmailClient();
        const res = await gmail.users.getProfile({ userId: 'me' });
        return { ok: true, email: res.data.emailAddress ?? undefined };
    }
    catch (e) {
        return { ok: false, error: explainError(e) };
    }
}
