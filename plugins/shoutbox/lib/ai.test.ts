// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { mentionsBot, buildHistory, maybeAnswer } from './ai.js';
import { makeToken } from './tokens.js';

// Foundation `tokens.js` (already on main) hardened `makeToken` to reject ids
// that are not 36-char hex/hyphen UUIDs (see tokens.test.ts). The plan's loose
// `'u9'` placeholder would throw, so — consistent with that merged adaptation —
// the recommended-media id below is a real UUID.
const REC_UUID = '99999999-9999-9999-9999-999999999999';

describe('ai mention', () => {
    it('detects @botname (case-insensitive, word-ish)', () => {
        expect(mentionsBot('hey @mybot recommend', 'mybot')).toBe(true);
        expect(mentionsBot('@MyBot?', 'mybot')).toBe(true);
        expect(mentionsBot('no mention', 'mybot')).toBe(false);
    });

    it('buildHistory maps messages to roles with name prefixes, bot→assistant', () => {
        const msgs = [
            { username: 'alice', author_kind: 'user', body: 'hi' },
            { username: 'mybot', author_kind: 'ai', body: 'hello' },
        ];
        const h = buildHistory(msgs, 'mybot');
        expect(h).toEqual([
            { role: 'user', content: 'alice: hi' },
            { role: 'assistant', content: 'hello' },
        ]);
    });

    it('maybeAnswer no-ops when aiEnabled is false', async () => {
        const ctx = {
            settings: async () => ({ aiEnabled: false, aiBotName: 'mybot' }),
            ai: { ask: vi.fn() },
        } as never;
        await maybeAnswer(ctx, { id: '1', username: 'a' }, '@mybot hi');
        expect((ctx as { ai: { ask: ReturnType<typeof vi.fn> } }).ai.ask).not.toHaveBeenCalled();
    });

    it('maybeAnswer posts a bot reply with recommended media as tokens', async () => {
        const publish = vi.fn(async () => undefined);
        const insert = vi.fn(async () => [
            {
                id: 'r1',
                username: 'mybot',
                user_group: 'ai',
                author_kind: 'ai',
                body: '',
                created_at: new Date(),
            },
        ]);
        const ctx = {
            sql: {},
            logger: { warn() {}, info() {} },
            settings: async () => ({
                aiEnabled: true,
                aiBotName: 'mybot',
                aiContextMessages: 5,
                aiContextScope: 'channel',
                aiSystemHint: 'be brief',
            }),
            ai: {
                ask: vi.fn(async () => ({
                    text: 'Try this',
                    recommendedMedia: [{ id: REC_UUID, mediaType: 'movie' }],
                    usage: { tokens: 1, costUsd: 0 },
                })),
            },
            realtime: { publish },
        } as never;
        await maybeAnswer(
            ctx,
            { id: '1', username: 'alice', user_id: 'u-alice' },
            '@mybot recommend',
            {
                insertMessage: insert,
                listRecent: async () => [],
                reserveAiInvocation: async () => true,
            },
        );
        expect((ctx as { ai: { ask: ReturnType<typeof vi.fn> } }).ai.ask).toHaveBeenCalled();
        const inserted = insert.mock.calls[0][1];
        expect(inserted.authorKind).toBe('ai');
        expect(inserted.body).toContain(makeToken(REC_UUID, 'movie'));
        expect(publish).toHaveBeenCalled();
        // Security fix C27, fix round 1 (2026-09-16): the host's realtime SSE
        // bridge forwards every published frame verbatim to every connected
        // client regardless of this room's own readGroups. index.js's
        // POST /messages publish was fixed to a bare {id} for the same
        // reason — this publisher (the AI bot reply) was the finding's other
        // named offender and was missed in the first pass.
        expect(publish).toHaveBeenCalledWith('message', { id: 'r1' });
    });
});

// security review 2026-09-13, C25 — the plugin declared `aiRateLimitPerHour`
// (settings field in index.js, default 20) but nothing ever read it: only the
// host's daily TOKEN budget (assistant-service.ts) capped usage, so a single
// user mentioning the bot in a loop could burn through it well before any
// other user got a turn. `maybeAnswer` must reserve a slot (via the injected
// `reserveAiInvocation`, mirroring `insertUserMessageRateLimited`'s
// atomic-INSERT pattern against a real `shoutbox_ai_invocations` table in
// production) BEFORE calling `ctx.ai.ask`, and the budget is per-user.
describe('ai per-hour rate limit (C25)', () => {
    function makeDeps(limitPerUser = 2) {
        const reservations = new Map<string, number>();
        const reserveAiInvocation = vi.fn(
            async (_sql: unknown, { userId, limit }: { userId: string; limit: number }) => {
                const count = reservations.get(userId) ?? 0;
                if (count >= limit) return false;
                reservations.set(userId, count + 1);
                return true;
            },
        );
        const insertMessage = vi.fn(async () => [
            {
                id: 'r1',
                username: 'mybot',
                user_group: 'ai',
                author_kind: 'ai',
                body: '',
                created_at: new Date(),
            },
        ]);
        return { reserveAiInvocation, insertMessage, listRecent: async () => [], limitPerUser };
    }

    function makeCtx(ask: ReturnType<typeof vi.fn>, aiRateLimitPerHour: number) {
        return {
            sql: {},
            logger: { warn() {}, info() {} },
            settings: async () => ({
                aiEnabled: true,
                aiBotName: 'mybot',
                aiRateLimitPerHour,
                aiContextMessages: 0,
            }),
            ai: { ask },
            realtime: { publish: vi.fn(async () => undefined) },
        } as never;
    }

    it('caps ctx.ai.ask calls at aiRateLimitPerHour for one asker within the hour', async () => {
        const ask = vi.fn(async () => ({
            text: 'ok',
            recommendedMedia: [],
            usage: { tokens: 1, costUsd: 0 },
        }));
        const ctx = makeCtx(ask, 2);
        const deps = makeDeps(2);

        await maybeAnswer(
            ctx,
            { id: '1', username: 'alice', user_id: 'u-alice' },
            '@mybot 1',
            deps,
        );
        await maybeAnswer(
            ctx,
            { id: '2', username: 'alice', user_id: 'u-alice' },
            '@mybot 2',
            deps,
        );
        await maybeAnswer(
            ctx,
            { id: '3', username: 'alice', user_id: 'u-alice' },
            '@mybot 3',
            deps,
        );

        expect(ask).toHaveBeenCalledTimes(2);
        expect(deps.reserveAiInvocation).toHaveBeenCalledTimes(3);
    });

    it('a different asker has an independent budget and still gets a reply', async () => {
        const ask = vi.fn(async () => ({
            text: 'ok',
            recommendedMedia: [],
            usage: { tokens: 1, costUsd: 0 },
        }));
        const ctx = makeCtx(ask, 2);
        const deps = makeDeps(2);

        await maybeAnswer(
            ctx,
            { id: '1', username: 'alice', user_id: 'u-alice' },
            '@mybot 1',
            deps,
        );
        await maybeAnswer(
            ctx,
            { id: '2', username: 'alice', user_id: 'u-alice' },
            '@mybot 2',
            deps,
        );
        await maybeAnswer(
            ctx,
            { id: '3', username: 'alice', user_id: 'u-alice' },
            '@mybot 3',
            deps,
        );
        expect(ask).toHaveBeenCalledTimes(2);

        await maybeAnswer(ctx, { id: '4', username: 'bob', user_id: 'u-bob' }, '@mybot hi', deps);
        expect(ask).toHaveBeenCalledTimes(3);
    });

    it('never calls ctx.ai.ask when the message carries no user_id (fail closed)', async () => {
        const ask = vi.fn(async () => ({ text: 'ok', recommendedMedia: [] }));
        const ctx = makeCtx(ask, 20);
        const deps = makeDeps(20);

        await maybeAnswer(ctx, { id: '1', username: 'ghost' }, '@mybot hi', deps);

        expect(ask).not.toHaveBeenCalled();
        expect(deps.reserveAiInvocation).not.toHaveBeenCalled();
    });
});
