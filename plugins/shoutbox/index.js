// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shoutbox — drop-in feature plugin. Demonstrates the Layer-A plugin-UI
 * extension point (routes + widget + realtime + media + ai).
 * Drop into $PLUGINS_EXTERNAL_DIR to load.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').FeatureDefinition}
 */
const shoutbox = {
    id: 'shoutbox',
    capabilities: { database: true, browserUi: true },
    settings: {
        fields: [
            {
                key: 'maxLength',
                type: 'number',
                label: 'Max message length',
                default: 280,
                validation: { min: 1, max: 2000 },
            },
            {
                key: 'historySize',
                type: 'number',
                label: 'History size',
                default: 50,
                validation: { min: 1, max: 500 },
            },
            {
                key: 'rateLimitPerMinute',
                type: 'number',
                label: 'Posts per minute / user',
                default: 6,
                validation: { min: 1, max: 120 },
            },
            {
                key: 'readGroups',
                type: 'array',
                groups: true,
                label: 'Groups allowed to read (empty = all)',
                default: [],
            },
            {
                key: 'postGroups',
                type: 'array',
                groups: true,
                label: 'Groups allowed to post (empty = all readers)',
                default: [],
            },
            {
                key: 'adminGroups',
                type: 'array',
                groups: true,
                label: 'Groups allowed to delete (empty = host admins)',
                default: [],
            },
            {
                key: 'groupColors',
                type: 'keyvalue',
                label: 'Per-group username colors',
                default: {},
            },
            { key: 'aiEnabled', type: 'boolean', label: 'Enable AI bot', default: false },
            {
                key: 'aiBotName',
                type: 'string',
                label: 'AI bot mention name',
                default: 'mybot',
                dependsOn: 'aiEnabled',
            },
            {
                key: 'aiRateLimitPerHour',
                type: 'number',
                dependsOn: 'aiEnabled',
                label: 'AI invocations / hour / user',
                description:
                    "Caps how many times per hour each user can trigger a bot reply. The host's daily AI token budget (per-user, admin/non-admin tiers) still applies on top of this — this setting bounds invocation FREQUENCY, not total spend.",
                default: 20,
                validation: { min: 1, max: 500 },
            },
            {
                key: 'aiContextMessages',
                type: 'number',
                dependsOn: 'aiEnabled',
                label: 'Recent messages given to the bot',
                default: 10,
                validation: { min: 0, max: 20 },
            },
            {
                key: 'aiContextScope',
                type: 'select',
                dependsOn: 'aiEnabled',
                label: 'AI context scope',
                default: 'channel',
                options: [
                    { value: 'channel', label: 'Whole channel' },
                    { value: 'asker-only', label: 'Asker only' },
                ],
            },
            {
                key: 'aiSystemHint',
                type: 'multiline',
                dependsOn: 'aiEnabled',
                label: 'AI persona/tone hint',
                default:
                    'You are in a public real-time shoutbox. Keep replies short and conversational (1-3 sentences).',
            },
        ],
    },
    routes: [
        {
            method: 'GET',
            path: '/config',
            handler: async (ctx) => {
                const { canRead, canPost } = await import('./lib/access.js');
                const cfg = await ctx.settings();
                const user = ctx.user;
                if (!user) return Response.json({ error: 'auth' }, { status: 401 });
                if (!canRead(user, cfg))
                    return Response.json({ error: 'forbidden' }, { status: 403 });
                return Response.json({
                    groupColors: cfg.groupColors ?? {},
                    maxLength: Number(cfg.maxLength) || 280,
                    canPost: canPost(user, cfg),
                    aiEnabled: Boolean(cfg.aiEnabled),
                    aiBotName: cfg.aiBotName || 'mybot',
                });
            },
        },
        {
            method: 'GET',
            path: '/messages',
            handler: async (ctx) => {
                const { ensureSchema } = await import('./lib/schema.js');
                const { canRead } = await import('./lib/access.js');
                const { listRecent, toWireMessage } = await import('./lib/queries.js');
                const { enrichChips } = await import('./lib/media.js');
                const cfg = await ctx.settings();
                const user = ctx.user;
                if (!user) return Response.json({ error: 'auth' }, { status: 401 });
                if (!canRead(user, cfg))
                    return Response.json({ error: 'forbidden' }, { status: 403 });
                await ensureSchema(ctx.sql);
                const rows = await listRecent(ctx.sql, Number(cfg.historySize) || 50);
                const messages = await Promise.all(
                    rows.map(async (row) => {
                        const { chips } = await enrichChips(ctx, row.body);
                        // toWireMessage, not a raw spread: it strips user_id and
                        // computes `mine` for THIS viewer. Spreading the row
                        // would broadcast every author's account id to the room.
                        return { ...toWireMessage(row, user.userId), chips };
                    }),
                );
                return Response.json({ messages });
            },
        },
        {
            method: 'GET',
            path: '/messages/:id',
            handler: async (ctx, req, params) => {
                const { ensureSchema } = await import('./lib/schema.js');
                const { canRead } = await import('./lib/access.js');
                const { getById, toWireMessage } = await import('./lib/queries.js');
                const { enrichChips } = await import('./lib/media.js');
                const cfg = await ctx.settings();
                const user = ctx.user;
                if (!user) return Response.json({ error: 'auth' }, { status: 401 });
                if (!canRead(user, cfg))
                    return Response.json({ error: 'forbidden' }, { status: 403 });
                await ensureSchema(ctx.sql);
                const id = params?.id;
                const row = id ? await getById(ctx.sql, id) : null;
                if (!row) return Response.json({ error: 'not found' }, { status: 404 });
                const { chips } = await enrichChips(ctx, row.body);
                return Response.json({ message: { ...toWireMessage(row, user.userId), chips } });
            },
        },
        {
            method: 'POST',
            path: '/messages',
            handler: async (ctx, req) => {
                const { ensureSchema } = await import('./lib/schema.js');
                const { canRead, canPost } = await import('./lib/access.js');
                const { insertUserMessageRateLimited } = await import('./lib/queries.js');
                const { sanitizeOutgoing, linkifyMediaUrls } = await import('./lib/media.js');
                const { maybeAnswer } = await import('./lib/ai.js');
                const cfg = await ctx.settings();
                const user = ctx.user;
                if (!user) return Response.json({ error: 'auth' }, { status: 401 });
                if (!canRead(user, cfg) || !canPost(user, cfg))
                    return Response.json({ error: 'forbidden' }, { status: 403 });
                await ensureSchema(ctx.sql);
                let raw;
                try {
                    raw = await req.json();
                } catch {
                    return Response.json({ error: 'bad json' }, { status: 400 });
                }
                let body = typeof raw?.body === 'string' ? raw.body.trim() : '';
                // Strip ASCII control characters (C0 range \x00-\x1f plus DEL \x7f),
                // newlines/tabs included, so chat lines stay single-line and clean.
                // eslint-disable-next-line no-control-regex
                body = body.replace(/[\x00-\x1f\x7f]/g, '');
                const maxLength = Number(cfg.maxLength) || 280;
                if (!body) return Response.json({ error: 'empty' }, { status: 400 });
                if (body.length > maxLength)
                    return Response.json({ error: 'too long' }, { status: 400 });
                const rate = Number(cfg.rateLimitPerMinute) || 6;
                // Auto-convert pasted media URLs (?modal=<uuid> / /watch/<uuid>) into
                // {{media:...}} chips — author-access-checked. Runs AFTER the length cap so
                // the bounded input limits how many URLs we resolve (DoS guard).
                body = await linkifyMediaUrls(ctx, body);
                body = await sanitizeOutgoing(ctx, body); // strip tokens author can't see
                // Re-check emptiness: sanitizeOutgoing can strip a body down to nothing
                // when it consisted solely of media tokens the author can't access.
                // Inserting that would broadcast a blank message to every reader.
                if (!body) return Response.json({ error: 'empty' }, { status: 400 });
                // Atomic rate limit: the count is evaluated inside the INSERT so two
                // concurrent posts can't both pass a separate prior check (TOCTOU).
                const userGroup = Array.isArray(user.groups) ? (user.groups[0] ?? null) : null;
                // A host that cannot identify the author must not accept the
                // post: a NULL user_id row is unattributable and permanently
                // undeletable by its own author. Older hosts predate
                // PluginUser.userId, so this is a real runtime case, not just a
                // type guard.
                if (!user.userId) {
                    ctx.logger.warn('shoutbox: host supplied no userId; refusing post');
                    return Response.json({ error: 'unsupported host' }, { status: 500 });
                }
                const row = await insertUserMessageRateLimited(ctx.sql, {
                    userId: user.userId,
                    username: user.username,
                    userGroup,
                    body,
                    replyTo: null,
                    limit: rate,
                    windowSeconds: 60,
                });
                if (!row) return Response.json({ error: 'rate' }, { status: 429 });
                const { toWireMessage } = await import('./lib/queries.js');
                // Security fix C27 (2026-09-16): the host's realtime SSE
                // bridge (/api/plugins/[featureId]/realtime) forwards every
                // frame verbatim to every connected client regardless of
                // this room's own readGroups — it has no access hook, and
                // the SDK documents the channel as broadcast. Publishing
                // username/group/hasMedia here leaked them to a reader
                // `GET /messages` would 403. A bare id is enough: the widget
                // re-fetches the full message through the gated route and
                // only falls back to a placeholder if that fetch itself
                // 403s — which is the correct outcome for an unauthorized
                // reader.
                await ctx.realtime?.publish('message', { id: row.id });
                // Fire AI if mentioned (Task 7) — detached, never awaited.
                void maybeAnswer(ctx, row, body).catch((e) =>
                    ctx.logger.warn('ai answer failed', { err: String(e) }),
                );
                // The author's own POST echo is by definition `mine: true`.
                return Response.json({ message: toWireMessage(row, user.userId) });
            },
        },
        {
            method: 'DELETE',
            path: '/messages/:id',
            handler: async (ctx, req, params) => {
                const { ensureSchema } = await import('./lib/schema.js');
                const { canModerate, canRead } = await import('./lib/access.js');
                const { softDelete, softDeleteOwn } = await import('./lib/queries.js');
                const cfg = await ctx.settings();
                const user = ctx.user;
                if (!user) return Response.json({ error: 'auth' }, { status: 401 });

                // Two ways to delete a message, and the distinction is the point.
                //
                // Moderators delete anything. Everyone else may delete their OWN
                // messages — which they previously could not do at all: DELETE
                // was moderator-only, and `adminGroups` defaults to empty, so on
                // a stock install nobody but a server admin could remove
                // anything. A user who mis-posted had no recourse but to ask.
                //
                // Gated on canRead rather than canPost: losing the right to
                // speak should not strand what you already said in a room you
                // can still see.
                const moderator = canModerate(user, cfg);
                if (!moderator && !canRead(user, cfg))
                    return Response.json({ error: 'forbidden' }, { status: 403 });

                await ensureSchema(ctx.sql);
                const id = params?.id;
                if (!id) return Response.json({ error: 'bad request' }, { status: 400 });

                if (moderator) {
                    await softDelete(ctx.sql, id);
                } else {
                    // Ownership is enforced in the UPDATE's WHERE clause, so
                    // there is no check-then-act window. A miss is reported as
                    // 403 without saying whether the message exists, belongs to
                    // someone else, or was already deleted — distinguishing them
                    // would let anyone probe for message ids.
                    const deleted = await softDeleteOwn(ctx.sql, id, user.userId);
                    if (!deleted) return Response.json({ error: 'forbidden' }, { status: 403 });
                }

                await ctx.realtime?.publish('delete', { id });
                return Response.json({ ok: true });
            },
        },
        {
            method: 'GET',
            path: '/media-search',
            handler: async (ctx, req) => {
                const { canRead, canPost } = await import('./lib/access.js');
                const cfg = await ctx.settings();
                const user = ctx.user;
                if (!user) return Response.json({ error: 'auth' }, { status: 401 });
                if (!canRead(user, cfg) || !canPost(user, cfg))
                    return Response.json({ error: 'forbidden' }, { status: 403 });
                const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
                if (!q) return Response.json({ results: [] });
                const results = (await ctx.media?.search?.(q, { limit: 8 })) ?? [];
                return Response.json({ results });
            },
        },
        {
            method: 'GET',
            path: '/widget.js',
            handler: async () => {
                const { readFile } = await import('node:fs/promises');
                const { fileURLToPath } = await import('node:url');
                const path = fileURLToPath(new URL('./widget.js', import.meta.url));
                const code = await readFile(path, 'utf8');
                return new Response(code, {
                    headers: {
                        'Content-Type': 'text/javascript; charset=utf-8',
                        'Cache-Control': 'public, max-age=300',
                    },
                });
            },
        },
    ],
    widgets: [
        {
            id: 'main',
            title: 'Shoutbox',
            entry: '/widget.js',
            placement: 'home',
            defaultVisible: true,
        },
    ],
    async onStartup(ctx) {
        try {
            const { ensureSchema } = await import('./lib/schema.js');
            await ensureSchema(ctx.sql);
        } catch (err) {
            ctx.logger.warn('shoutbox onStartup ensureSchema failed', { err: String(err) });
        }
        // Retention for shoutbox_ai_invocations. reserveAiInvocation prunes as
        // it reserves, which bounds the table wherever the bot is still used —
        // but that leaves the install where AI was switched off, or nobody
        // mentions the bot any more, holding whatever it last wrote forever.
        // A restart is the only scheduled moment a FeatureDefinition gets (the
        // contract has no cron hook; a TaskDefinition would mean promoting this
        // plugin to a multi-contract bundle and registering a host task to
        // delete a handful of rows), so collect them here. Separate try: a
        // failed prune must not mask a successful ensureSchema, and neither
        // may fail startup.
        try {
            const { pruneAiInvocations } = await import('./lib/queries.js');
            const deleted = await pruneAiInvocations(ctx.sql);
            if (deleted > 0) {
                ctx.logger.info?.('shoutbox pruned expired AI invocation rows', { deleted });
            }
        } catch (err) {
            ctx.logger.warn('shoutbox onStartup pruneAiInvocations failed', { err: String(err) });
        }
    },
};

export default shoutbox;
