import { z } from 'zod';
import { LABEL_COLOR_PRESETS } from './gmail.js';
import { FORMAT_DESCRIPTION } from './format.js';
const def = (t) => t;
const format = z
    .enum(['minimal', 'metadata', 'plain_text', 'full', 'raw'])
    .optional()
    .describe(FORMAT_DESCRIPTION);
const email = z
    .string()
    .describe('An email address, optionally with a display name: "Name <user@example.com>" or "user@example.com".');
const emails = z.array(email).optional();
const attachment = z
    .union([
    z.string().describe('Absolute path of a local file to attach.'),
    z.object({
        path: z.string().optional().describe('Absolute path of a local file.'),
        content: z
            .string()
            .optional()
            .describe('Base64 content, only when the file is not on disk. Prefer "path" for anything larger than a few KB.'),
        filename: z
            .string()
            .optional()
            .describe('Filename shown to the recipient. Defaults to the basename of "path". Required with "content".'),
        mimeType: z
            .string()
            .optional()
            .describe('MIME type. Detected from the filename when omitted.'),
        inline: z
            .boolean()
            .optional()
            .describe('Attach as an inline image referenced from htmlBody as <img src="cid:CONTENT_ID">.'),
        contentId: z
            .string()
            .optional()
            .describe('Content-ID for an inline attachment. Defaults to the filename.'),
    }),
])
    .describe('A local file path, or an object with path/content plus options.');
const attachments = z
    .array(attachment)
    .optional()
    .describe("Files to attach, as local paths (preferred: any size up to Gmail's 25 MB total) or base64 objects.");
const QUERY_HELP = 'Gmail search syntax, exactly as in the Gmail search box. Operators: from:, to:, cc:, bcc:, subject:, ' +
    'label:NAME, in:(inbox|sent|drafts|trash|spam|anywhere|archive), is:(unread|read|starred|important), has:attachment, ' +
    'filename:pdf, after:YYYY/MM/DD, before:YYYY/MM/DD, newer_than:7d, older_than:1y, larger:10M, "exact phrase", ' +
    'OR, -negation, ( ) grouping, {a b} for OR. Whitespace is AND. Keep queries keyword-based rather than pasting whole subjects.';
const BODY_HELP = 'Plain-text body. One line per paragraph, no hard wrapping; Gmail wraps on display and links bare URLs. ' +
    'Markdown does NOT render: for bullets or other formatting supply htmlBody instead.';
const HTML_HELP = 'HTML body, used when the message needs formatting such as <ul><li> lists. When given, "body" becomes the plain-text ' +
    'alternative (derived from the HTML if omitted). Do not include the signature; it is appended.';
const SIGNATURE_HELP = 'Set false to send without the configured signature. By default the signature (from config.json, GMAIL_SIGNATURE, or ' +
    'the Gmail settings signature) is appended once; a copy typed into the body is de-duplicated.';
export const tools = [
    // ---- identity ----
    def({
        name: 'get_profile',
        description: 'The authenticated account: email address, total message and thread counts, current history ID. Use it to learn whose mailbox this is.',
        schema: {},
        readOnly: true,
        handler: (_a, g) => g.getProfile(),
    }),
    // ---- search and read ----
    def({
        name: 'search_threads',
        description: 'Search conversations (threads). Returns one row per thread: subject, snippet, participants, message count, last date, ' +
            'label IDs and message IDs, without bodies. Use get_thread to read one. Drafts-only threads are excluded unless the ' +
            'query mentions drafts. An empty list means nothing matched.',
        schema: {
            query: z.string().optional().describe(QUERY_HELP),
            maxResults: z
                .number()
                .int()
                .min(1)
                .max(500)
                .optional()
                .describe('Threads per page. Default 20.'),
            pageToken: z
                .string()
                .optional()
                .describe('nextPageToken from a previous call, to fetch the next page.'),
            labelIds: z
                .array(z.string())
                .optional()
                .describe('Restrict to threads carrying all of these label IDs.'),
            includeSpamTrash: z.boolean().optional().describe('Include Spam and Trash. Default false.'),
            view: z
                .enum(['minimal', 'metadata', 'messages'])
                .optional()
                .describe('"minimal" (default): thread summary. "metadata": summary without subject or snippet. "messages": also list each message\'s headers.'),
        },
        readOnly: true,
        handler: (a, g) => g.searchThreads(a),
    }),
    def({
        name: 'search_messages',
        description: 'Search individual messages rather than threads: one row per message with headers, snippet and labels. Better than ' +
            'search_threads when you need a specific message ID (to reply, forward, label or fetch attachments) or a date-ordered list.',
        schema: {
            query: z.string().optional().describe(QUERY_HELP),
            maxResults: z
                .number()
                .int()
                .min(1)
                .max(500)
                .optional()
                .describe('Messages per page. Default 20.'),
            pageToken: z.string().optional(),
            labelIds: z
                .array(z.string())
                .optional()
                .describe('Restrict to messages carrying all of these label IDs.'),
            includeSpamTrash: z.boolean().optional(),
            format: z
                .enum(['minimal', 'metadata', 'plain_text', 'full'])
                .optional()
                .describe('Per-message detail. Default "minimal" (no bodies). "plain_text" fetches bodies too: slower and larger.'),
        },
        readOnly: true,
        handler: (a, g) => g.searchMessages(a),
    }),
    def({
        name: 'get_message',
        description: 'Read one message by ID: headers, labels, attachment list and body. Not for drafts; use get_draft for those.',
        schema: { messageId: z.string(), format },
        readOnly: true,
        handler: (a, g) => g.getMessage(a.messageId, a.format ?? 'plain_text'),
    }),
    def({
        name: 'get_thread',
        description: 'Read a whole conversation: every message in the thread, oldest first, with bodies. Drafts in the thread are included as messages with the DRAFT label.',
        schema: { threadId: z.string(), format },
        readOnly: true,
        handler: (a, g) => g.getThread(a.threadId, a.format ?? 'plain_text'),
    }),
    // ---- attachments ----
    def({
        name: 'list_attachments',
        description: 'List the attachments on a message: filename, MIME type, size, attachment ID, and whether it is an inline image.',
        schema: { messageId: z.string() },
        readOnly: true,
        handler: (a, g) => g.listAttachments(a.messageId),
    }),
    def({
        name: 'save_attachments',
        description: 'Download attachments from a message to a local directory and return the written paths. All regular attachments by ' +
            'default; narrow with filenameContains or attachmentId. Existing files are not overwritten unless overwrite is set ' +
            '(a numbered copy is written instead).',
        schema: {
            messageId: z.string(),
            directory: z.string().describe('Directory to write into; created if missing.'),
            filenameContains: z
                .string()
                .optional()
                .describe('Case-insensitive substring filter on the filename.'),
            attachmentId: z
                .string()
                .optional()
                .describe('Save exactly this attachment (from list_attachments).'),
            includeInline: z
                .boolean()
                .optional()
                .describe('Also save inline images (signature logos and the like). Default false.'),
            overwrite: z.boolean().optional(),
        },
        handler: (a, g) => g.saveAttachments(a),
    }),
    // ---- drafts ----
    def({
        name: 'create_draft',
        description: 'Create a draft. With replyToMessageId it becomes a reply in that thread (subject, In-Reply-To and References set; ' +
            'the original is quoted below the new text unless quote is false); recipients are still yours to give, or use reply ' +
            "with asDraft for Gmail's default recipients. Attachments are local file paths. Returns the draft ID, message ID, thread ID and a Gmail link.",
        schema: {
            to: emails,
            cc: emails,
            bcc: emails,
            subject: z
                .string()
                .optional()
                .describe('Title Case. Defaults to "Re: <original>" when replying.'),
            body: z.string().optional().describe(BODY_HELP),
            htmlBody: z.string().optional().describe(HTML_HELP),
            attachments,
            replyToMessageId: z
                .string()
                .optional()
                .describe('Message ID to reply to; threads the draft and quotes the original.'),
            quote: z
                .boolean()
                .optional()
                .describe('Quote the replied-to message below the new text. Default true.'),
            signature: z.boolean().optional().describe(SIGNATURE_HELP),
        },
        handler: (a, g) => g.createDraft(a, a.replyToMessageId ? 'reply' : 'new'),
    }),
    def({
        name: 'update_draft',
        description: 'Edit an existing draft. Only the fields given change; recipients, subject, threading and attachments are kept ' +
            'otherwise. Giving body or htmlBody replaces the whole body (including any quoted original), and the signature is ' +
            "re-appended. Giving attachments replaces the attachment set; clearAttachments removes them all. Note the draft's " +
            'message ID changes on every update while the draft ID stays the same.',
        schema: {
            draftId: z.string(),
            to: emails,
            cc: emails,
            bcc: emails,
            subject: z.string().optional(),
            body: z.string().optional().describe(BODY_HELP),
            htmlBody: z.string().optional().describe(HTML_HELP),
            attachments,
            clearAttachments: z.boolean().optional(),
            signature: z.boolean().optional().describe(SIGNATURE_HELP),
        },
        handler: (a, g) => g.updateDraft(a),
    }),
    def({
        name: 'get_draft',
        description: 'Read a draft by draft ID (not message ID): recipients, subject, body, attachments and a Gmail link.',
        schema: { draftId: z.string(), format },
        readOnly: true,
        handler: (a, g) => g.getDraft(a.draftId, a.format ?? 'plain_text'),
    }),
    def({
        name: 'list_drafts',
        description: 'List drafts, newest first, with draft IDs. Filter with a Gmail query. view "full" adds bodies.',
        schema: {
            query: z.string().optional().describe(QUERY_HELP),
            maxResults: z.number().int().min(1).max(500).optional().describe('Default 20.'),
            pageToken: z.string().optional(),
            view: z
                .enum(['metadata', 'full'])
                .optional()
                .describe('"metadata" (default): headers and snippet. "full": also the plain-text body.'),
        },
        readOnly: true,
        handler: (a, g) => g.listDrafts(a),
    }),
    def({
        name: 'delete_draft',
        description: 'Discard a draft permanently by draft ID. Does not affect the thread it belongs to.',
        schema: { draftId: z.string() },
        destructive: true,
        handler: (a, g) => g.deleteDraft(a.draftId),
    }),
    def({
        name: 'send_draft',
        description: 'Send an existing draft as-is. Returns the sent message ID and thread ID.',
        schema: { draftId: z.string() },
        handler: (a, g) => g.sendDraft(a.draftId),
    }),
    // ---- sending ----
    def({
        name: 'send_message',
        description: 'Send a new message immediately. To thread it into an existing conversation give replyToMessageId (quotes and ' +
            'threads on that message) or replyThreadId (threads only). To send a draft instead, give draftId and nothing else. ' +
            "For replies with Gmail's default recipients use the reply tool. Prefer create_draft when the user should review first.",
        schema: {
            draftId: z
                .string()
                .optional()
                .describe('Send this existing draft; all other fields are ignored.'),
            to: emails,
            cc: emails,
            bcc: emails,
            subject: z.string().optional().describe('Title Case.'),
            body: z.string().optional().describe(BODY_HELP),
            htmlBody: z.string().optional().describe(HTML_HELP),
            attachments,
            replyToMessageId: z.string().optional(),
            replyThreadId: z.string().optional(),
            quote: z
                .boolean()
                .optional()
                .describe('When replyToMessageId is set, quote it below the new text. Default true.'),
            signature: z.boolean().optional().describe(SIGNATURE_HELP),
        },
        handler: async (a, g) => {
            if (a.draftId)
                return g.sendDraft(a.draftId);
            if (!a.to?.length && !a.cc?.length && !a.bcc?.length)
                throw new Error('send_message needs at least one recipient (or a draftId).');
            return g.sendNew(a, a.replyToMessageId ? 'reply' : 'new');
        },
    }),
    def({
        name: 'reply',
        description: "Reply to a message with Gmail's default recipients: the sender (or Reply-To), plus everyone on To and Cc except " +
            'yourself when replyAll is true. Threaded, subject prefixed with Re:, original quoted below, signature appended. ' +
            'Sends immediately unless asDraft is true, which leaves a draft to review. to/cc/bcc override the defaults.',
        schema: {
            messageId: z
                .string()
                .describe('The message to reply to; usually the latest in the thread (see get_thread).'),
            body: z.string().optional().describe(BODY_HELP),
            htmlBody: z.string().optional().describe(HTML_HELP),
            replyAll: z.boolean().optional().describe('Default false.'),
            asDraft: z.boolean().optional().describe('Create a draft instead of sending. Default false.'),
            to: emails.describe('Override the default To.'),
            cc: emails.describe('Override the default Cc.'),
            bcc: emails,
            attachments,
            quote: z.boolean().optional().describe('Default true.'),
            signature: z.boolean().optional().describe(SIGNATURE_HELP),
        },
        handler: (a, g) => {
            if (a.body === undefined && a.htmlBody === undefined)
                throw new Error('reply needs body or htmlBody.');
            return g.reply(a);
        },
    }),
    def({
        name: 'forward',
        description: 'Forward a message: your comment on top, then the standard "Forwarded message" block with the original headers ' +
            'and body, with the original attachments re-attached (includeAttachments false to drop them). Subject prefixed ' +
            'with Fwd:. Sends immediately unless asDraft is true.',
        schema: {
            messageId: z.string(),
            to: z.array(email).min(1),
            cc: emails,
            bcc: emails,
            body: z
                .string()
                .optional()
                .describe('Comment placed above the forwarded message. ' + BODY_HELP),
            htmlBody: z.string().optional().describe(HTML_HELP),
            includeAttachments: z.boolean().optional().describe('Default true.'),
            attachments: attachments.describe('Additional files to attach.'),
            asDraft: z.boolean().optional().describe('Create a draft instead of sending. Default false.'),
            signature: z.boolean().optional().describe(SIGNATURE_HELP),
        },
        handler: (a, g) => g.forward(a),
    }),
    // ---- labels ----
    def({
        name: 'list_labels',
        description: 'All labels with IDs, names, type (system or user), colors and visibility. System labels: INBOX, UNREAD, STARRED, IMPORTANT, SENT, DRAFT, TRASH, SPAM, CATEGORY_*. Label tools accept either an ID or an exact name.',
        schema: {},
        readOnly: true,
        handler: (_a, g) => g.listLabels(),
    }),
    def({
        name: 'get_label',
        description: 'One label with its message and thread counts (total and unread).',
        schema: { labelId: z.string().describe('Label ID or exact name.') },
        readOnly: true,
        handler: async (a, g) => g.getLabel((await g.resolveLabelIds([a.labelId]))[0]),
    }),
    def({
        name: 'create_label',
        description: 'Create a label. Nested labels use "/" (Projects/Alpha); missing parents are created unless autoCreateParents is false. Color by preset name or by hex pair from Gmail\'s palette.',
        schema: {
            name: z.string(),
            colorPreset: z
                .string()
                .optional()
                .describe(`One of: ${Object.keys(LABEL_COLOR_PRESETS).join(', ')} (LABEL_COLOR_PRESET_ prefix accepted).`),
            backgroundColor: z
                .string()
                .optional()
                .describe("Hex color from Gmail's label palette, e.g. #fb4c2f. Arbitrary colors are rejected by Gmail."),
            textColor: z.string().optional(),
            labelListVisibility: z
                .enum(['labelShow', 'labelShowIfUnread', 'labelHide'])
                .optional()
                .describe('Default labelShow.'),
            messageListVisibility: z.enum(['show', 'hide']).optional().describe('Default show.'),
            autoCreateParents: z.boolean().optional(),
        },
        handler: (a, g) => g.createLabel(a),
    }),
    def({
        name: 'update_label',
        description: 'Rename a label or change its color or visibility.',
        schema: {
            labelId: z.string().describe('Label ID or exact current name.'),
            name: z.string().optional(),
            colorPreset: z
                .string()
                .optional()
                .describe(`One of: ${Object.keys(LABEL_COLOR_PRESETS).join(', ')}.`),
            backgroundColor: z.string().optional(),
            textColor: z.string().optional(),
            labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional(),
            messageListVisibility: z.enum(['show', 'hide']).optional(),
        },
        handler: async (a, g) => g.updateLabel({ ...a, labelId: (await g.resolveLabelIds([a.labelId]))[0] }),
    }),
    def({
        name: 'delete_label',
        description: 'Delete a user label. Messages keep their other labels. System labels cannot be deleted.',
        schema: { labelId: z.string().describe('Label ID or exact name.') },
        destructive: true,
        handler: async (a, g) => g.deleteLabel((await g.resolveLabelIds([a.labelId]))[0]),
    }),
    def({
        name: 'label_message',
        description: 'Add labels to one message. IDs or exact names; system labels too (STARRED, IMPORTANT, INBOX, UNREAD). Use trash_message or mark_message_spam for those states.',
        schema: { messageId: z.string(), labelIds: z.array(z.string()).min(1) },
        handler: (a, g) => g.modifyMessage(a.messageId, a.labelIds, []),
    }),
    def({
        name: 'unlabel_message',
        description: 'Remove labels from one message. Removing INBOX archives it; removing UNREAD marks it read.',
        schema: { messageId: z.string(), labelIds: z.array(z.string()).min(1) },
        handler: (a, g) => g.modifyMessage(a.messageId, [], a.labelIds),
    }),
    def({
        name: 'update_message_labels',
        description: 'Add and remove labels on one message in a single call, e.g. move between labels or mark read and archive at once.',
        schema: {
            messageId: z.string(),
            addLabelIds: z.array(z.string()).optional(),
            removeLabelIds: z.array(z.string()).optional(),
        },
        handler: (a, g) => {
            if (!a.addLabelIds?.length && !a.removeLabelIds?.length)
                throw new Error('Give addLabelIds and/or removeLabelIds.');
            return g.modifyMessage(a.messageId, a.addLabelIds ?? [], a.removeLabelIds ?? []);
        },
    }),
    def({
        name: 'label_thread',
        description: 'Add labels to every message in a thread (and, for user labels, future messages in it).',
        schema: { threadId: z.string(), labelIds: z.array(z.string()).min(1) },
        handler: (a, g) => g.modifyThread(a.threadId, a.labelIds, []),
    }),
    def({
        name: 'unlabel_thread',
        description: 'Remove labels from every message in a thread. Removing INBOX archives the conversation; removing UNREAD marks it read.',
        schema: { threadId: z.string(), labelIds: z.array(z.string()).min(1) },
        handler: (a, g) => g.modifyThread(a.threadId, [], a.labelIds),
    }),
    def({
        name: 'update_thread_labels',
        description: 'Add and remove labels on a whole thread in one call.',
        schema: {
            threadId: z.string(),
            addLabelIds: z.array(z.string()).optional(),
            removeLabelIds: z.array(z.string()).optional(),
        },
        handler: (a, g) => {
            if (!a.addLabelIds?.length && !a.removeLabelIds?.length)
                throw new Error('Give addLabelIds and/or removeLabelIds.');
            return g.modifyThread(a.threadId, a.addLabelIds ?? [], a.removeLabelIds ?? []);
        },
    }),
    def({
        name: 'batch_modify_messages',
        description: 'Bulk label change: over a list of message IDs, or over every message matching a Gmail query (up to maxMessages, ' +
            'default 500). Built for triage such as archiving a newsletter\'s backlog (query "from:news@x.com", ' +
            'removeLabelIds ["INBOX"]) or marking a search read. Returns the count and IDs touched.',
        schema: {
            messageIds: z.array(z.string()).optional(),
            query: z.string().optional().describe(QUERY_HELP),
            maxMessages: z.number().int().min(1).max(5000).optional(),
            addLabelIds: z.array(z.string()).optional(),
            removeLabelIds: z.array(z.string()).optional(),
        },
        destructive: true,
        handler: (a, g) => {
            if (!a.messageIds?.length && !a.query)
                throw new Error('Give messageIds or a query.');
            if (!a.addLabelIds?.length && !a.removeLabelIds?.length)
                throw new Error('Give addLabelIds and/or removeLabelIds.');
            return g.batchModify({
                messageIds: a.messageIds,
                query: a.query,
                maxMessages: a.maxMessages,
                add: a.addLabelIds,
                remove: a.removeLabelIds,
            });
        },
    }),
    // ---- trash and spam ----
    def({
        name: 'trash_message',
        description: "Move one message to Trash (also works on a draft's message ID). Prefer trash_thread for whole conversations.",
        schema: { messageId: z.string() },
        destructive: true,
        handler: (a, g) => g.trashMessage(a.messageId),
    }),
    def({
        name: 'untrash_message',
        description: 'Restore one message from Trash.',
        schema: { messageId: z.string() },
        handler: (a, g) => g.untrashMessage(a.messageId),
    }),
    def({
        name: 'trash_thread',
        description: 'Move every message in a thread to Trash.',
        schema: { threadId: z.string() },
        destructive: true,
        handler: (a, g) => g.trashThread(a.threadId),
    }),
    def({
        name: 'untrash_thread',
        description: 'Restore every message in a thread from Trash.',
        schema: { threadId: z.string() },
        handler: (a, g) => g.untrashThread(a.threadId),
    }),
    def({
        name: 'mark_message_spam',
        description: 'Mark one message as spam (adds SPAM, removes INBOX).',
        schema: { messageId: z.string() },
        destructive: true,
        handler: (a, g) => g.spamMessage(a.messageId),
    }),
    def({
        name: 'unmark_message_spam',
        description: 'Un-spam one message (removes SPAM, restores INBOX).',
        schema: { messageId: z.string() },
        handler: (a, g) => g.unspamMessage(a.messageId),
    }),
    def({
        name: 'mark_thread_spam',
        description: 'Mark a whole thread as spam.',
        schema: { threadId: z.string() },
        destructive: true,
        handler: (a, g) => g.spamThread(a.threadId),
    }),
    def({
        name: 'unmark_thread_spam',
        description: 'Un-spam a whole thread.',
        schema: { threadId: z.string() },
        handler: (a, g) => g.unspamThread(a.threadId),
    }),
    def({
        name: 'apply_sensitive_message_label',
        description: 'Compatibility alias for the official server: TRASH or SPAM one message. Prefer trash_message / mark_message_spam.',
        schema: { messageId: z.string(), labelOption: z.enum(['TRASH', 'SPAM']) },
        destructive: true,
        handler: (a, g) => a.labelOption === 'TRASH' ? g.trashMessage(a.messageId) : g.spamMessage(a.messageId),
    }),
    def({
        name: 'apply_sensitive_thread_label',
        description: 'Compatibility alias for the official server: TRASH or SPAM a whole thread. Prefer trash_thread / mark_thread_spam.',
        schema: { threadId: z.string(), labelOption: z.enum(['TRASH', 'SPAM']) },
        destructive: true,
        handler: (a, g) => a.labelOption === 'TRASH' ? g.trashThread(a.threadId) : g.spamThread(a.threadId),
    }),
];
export const toolByName = (name) => tools.find((t) => t.name === name);
