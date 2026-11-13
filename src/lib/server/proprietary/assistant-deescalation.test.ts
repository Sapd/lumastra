// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserContext } from '$lib/server/types.js';
import type { ChatProvider, ChatResult } from './assistant-provider/types.js';

// --- Module mocks (declared before importing assistant-service) -------------
// runAssistant performs a full LLM round-trip; we stub every heavy dependency
// up to (and including) the tool-build call so we can drive it to the point
// where `streamsViewable` is computed and passed to buildAssistantTools.

// Force features.sessionsPublic = true: this is the value that, in NON-restricted
// mode, would make get_active_streams visible. The invariant under test is that
// restricted mode forces streamsViewable=false REGARDLESS of this.
// Group config matches the documented defaults the deEscalateUser cases assume:
// ADMIN_GROUPS='admin', WATCH_PERMISSION_GROUPS='admin,stream-monitors',
// LIVETV_GROUPS='livetv,admin'.
vi.mock('$lib/server/config', () => ({
    config: {
        ADMIN_GROUPS: ['admin'],
        WATCH_PERMISSION_GROUPS: ['admin', 'stream-monitors'],
        LIVETV_GROUPS: ['livetv', 'admin'],
    },
    features: {
        sessionsPublic: true,
        audiobooks: false,
        kavita: false,
        personalStats: false,
        jellyfinSync: true,
    },
}));

const publicEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/public', () => ({ env: publicEnv }));

vi.mock('$lib/server/config/domains/ai', () => ({
    getAiConfig: () => ({
        openaiApiKey: 'test-key',
        openaiChatApiKey: 'test-key',
        openaiBaseUrl: undefined,
        openaiChatModel: 'gpt-4o',
        assistantName: 'Assistant',
        assistantDailyTokenLimitAdmin: 1_000_000,
        assistantDailyTokenLimitUser: 1_000_000,
    }),
}));

// `searchAccessBoundary` is deliberately NOT mocked: runAssistant projects the
// access context through it to build the required MediaAccessBoundary, and the
// real projection must run.
vi.mock('$lib/server/utils/search-access-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/search-access-context')>();
    return {
        ...actual,
        // Derives ageRating from the passed user, exactly as the real
        // buildSearchAccessContext does. Load-bearing: de-escalation's whole
        // effect on the age axis is that it sets user.maxAgeRating, and a mock
        // that returned a constant `ageRating: null` would mask it.
        buildSearchAccessContext: async (
            _sql: unknown,
            user: { username: string; maxAgeRating: number | null },
        ) => ({
            username: user.username,
            deniedGroupIds: null,
            ageRating:
                user.maxAgeRating != null
                    ? { maxAgeRating: user.maxAgeRating, allowUnrated: false }
                    : null,
            liveTvAllowed: false,
            showUnavailableMedia: true,
        }),
    };
});

vi.mock('$lib/server/proprietary/assistant-tools/capability', () => ({
    assistantToolsEnabled: () => true,
}));

vi.mock('$lib/server/database/queries/assistant-rag.queries', () => ({
    getUserRecentRatings: async () => [],
    getDailyTokenUsage: async () => 0,
    recordChatTokenUsage: async () => undefined,
    findRelevantMediaByVector: async () => [],
}));

const recentWatchedSpy = vi.fn(async (_sql: unknown, _params: unknown) => []);
vi.mock('$lib/server/database/queries/user-watch-history.queries', () => ({
    getRecentWatchedWithTitles: {
        all: (sql: unknown, params: unknown) => recentWatchedSpy(sql, params),
    },
}));

vi.mock('$lib/server/database/queries/assistant.queries', () => ({
    insertUserMessage: async () => undefined,
    insertAssistantMessage: async () => undefined,
}));

vi.mock('$lib/server/proprietary/assistant-tools/dispatch', () => ({
    runAssistantToolLoop: async () => ({
        finalText: 'ok',
        mediaForCards: [],
        musicForCards: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        rounds: 1,
        toolCallCount: 0,
    }),
}));

// openai is constructed by getOpenAI() but never used (dispatch is mocked).
vi.mock('openai', () => ({ default: class OpenAI {} }));

// Spy on buildAssistantTools: this is where the streamsViewable invariant lands.
const buildAssistantToolsSpy = vi.fn((_opts: unknown) => []);
vi.mock('$lib/server/proprietary/assistant-tools/registry', () => ({
    buildAssistantTools: (opts: unknown) => buildAssistantToolsSpy(opts),
}));

const {
    deEscalateUser,
    RESTRICTED_DEFAULT_MAX_AGE_RATING,
    runAssistant,
    compactConversationHistory,
    buildRecommendedMovies,
} = await import('./assistant-service.js');

/**
 * Example names are fictional; production shapes and measurements are retained.
 * `deEscalateUser` is the de-escalation primitive that makes the plugin-facing
 * AI (`ctx.ai`) run as a NON-privileged principal even when the viewer is an
 * admin. These tests pin the security invariants:
 *  - admin / watch / live-tv privileges are dropped,
 *  - a real content age CEILING is set (never null in restricted mode),
 *  - the "child-profile" block flag (`isAgeRestricted`) stays false so the
 *    assistant is not refused outright (runAssistant throws on that flag),
 *  - privileged group memberships are stripped (they drive deniedGroups), but
 *    ordinary member groups survive.
 */
// Group names match the config defaults: ADMIN_GROUPS='admin',
// WATCH_PERMISSION_GROUPS='admin,stream-monitors', LIVETV_GROUPS='livetv,admin'.
const adminUser: UserContext = {
    userId: 'u-admin' as UserContext['userId'],
    username: 'admin',
    groups: 'admin|stream-monitors|livetv|members',
    userGroups: ['admin', 'stream-monitors', 'livetv', 'members'],
    hasWatchPermission: true,
    hasLiveTvPermission: true,
    hasRequestPermission: true,
    ownerIsAdmin: true,
    maxAgeRating: null, // admins are unrestricted
    isAgeRestricted: false,
    isModerator: true,
    liveTvPriority: 'high',
};

describe('deEscalateUser', () => {
    it('drops admin, watch, and live-tv privileges', () => {
        const d = deEscalateUser(adminUser);
        expect(d.ownerIsAdmin).toBe(false);
        expect(d.hasWatchPermission).toBe(false);
        expect(d.hasLiveTvPermission).toBe(false);
    });

    it('drops the media-access admin capability a session admin carries', async () => {
        const { toLibraryAccessUser } =
            await import('$lib/server/cache/library-group-permissions-cache.js');
        const d = deEscalateUser({ ...adminUser, mediaAccessIsAdmin: true });
        expect(d.mediaAccessIsAdmin).toBe(false);
        expect(toLibraryAccessUser(d)?.isAdmin).toBe(false);
    });

    it('sets a non-null content age ceiling (the non-admin default) when input was null', () => {
        const d = deEscalateUser(adminUser);
        expect(d.maxAgeRating).not.toBeNull();
        expect(d.maxAgeRating).toBe(RESTRICTED_DEFAULT_MAX_AGE_RATING);
    });

    it('keeps isAgeRestricted false (a content ceiling, NOT a blocked child profile)', () => {
        const d = deEscalateUser(adminUser);
        // CRITICAL: runAssistant throws AiUnavailableError when isAgeRestricted
        // is true. De-escalation sets a content CEILING (maxAgeRating), it must
        // never flip the blocked-profile flag.
        expect(d.isAgeRestricted).toBe(false);
    });

    it('preserves an existing (lower) non-admin age ceiling instead of overwriting it', () => {
        const restrictedMember: UserContext = {
            ...adminUser,
            ownerIsAdmin: false,
            maxAgeRating: 6,
            userGroups: ['members'],
            groups: 'members',
        };
        const d = deEscalateUser(restrictedMember);
        expect(d.maxAgeRating).toBe(6);
        expect(d.isAgeRestricted).toBe(false);
    });

    it('strips privileged group memberships but keeps ordinary member groups', () => {
        const d = deEscalateUser(adminUser);
        expect(d.userGroups).toContain('members');
        expect(d.userGroups).not.toContain('admin');
        expect(d.userGroups).not.toContain('stream-monitors');
        expect(d.userGroups).not.toContain('livetv');
        // `groups` string mirror is kept in sync with the stripped list.
        expect(d.groups).toBe(d.userGroups.join('|'));
    });
});

/**
 * End-to-end pin for invariant (b): the plugin-facing AI bridge
 * (`runAssistant({ restricted: true })`) must NEVER offer the operational,
 * cross-user `get_active_streams` tool — even for an admin viewer, and even
 * when the install has `features.sessionsPublic = true`.
 *
 * `deEscalateUser` (above) drops the principal's privileges, but the actual
 * tool-visibility decision lives in `runAssistant`:
 *
 *     const streamsViewable = restricted
 *         ? false
 *         : features.sessionsPublic || isUserAdmin(userGroups) || hasWatchPermission;
 *
 * The `deEscalateUser` unit tests do NOT cover that `restricted` short-circuit,
 * so a refactor removing it (e.g. relying solely on the de-escalated principal,
 * which loses no privilege that `sessionsPublic` checks) would silently expose
 * the tool to plugin callers without failing the suite. These tests spy on
 * `buildAssistantTools` and assert the `streamsViewable` flag it receives.
 *
 * `features.sessionsPublic` is mocked to `true` at the top of this file so the
 * non-restricted branch WOULD have set `streamsViewable: true` — proving the
 * restricted short-circuit, not an incidentally-falsy feature flag, is what
 * forces it false.
 */
describe('runAssistant restricted-mode stream-tool gate', () => {
    beforeEach(() => {
        buildAssistantToolsSpy.mockClear();
    });

    const runDeps = (restricted: boolean) => ({
        user: adminUser,
        sql: {} as never,
        restricted,
    });

    it('forces streamsViewable=false in restricted mode even when sessionsPublic=true and viewer is admin', async () => {
        await runAssistant({ message: 'who is watching right now?' }, runDeps(true));

        expect(buildAssistantToolsSpy).toHaveBeenCalledTimes(1);
        const opts = buildAssistantToolsSpy.mock.calls[0][0] as { streamsViewable: boolean };
        expect(opts.streamsViewable).toBe(false);
    });

    it('control: non-restricted mode with sessionsPublic=true DOES offer the stream tool', async () => {
        // Pins that the assertion above is meaningful — the same admin viewer,
        // same sessionsPublic=true, but WITHOUT the restricted short-circuit,
        // yields streamsViewable=true. Removing the short-circuit would flip the
        // restricted test to this value and fail.
        await runAssistant({ message: 'who is watching right now?' }, runDeps(false));

        expect(buildAssistantToolsSpy).toHaveBeenCalledTimes(1);
        const opts = buildAssistantToolsSpy.mock.calls[0][0] as { streamsViewable: boolean };
        expect(opts.streamsViewable).toBe(true);
    });
});

/**
 * End-to-end pin for the AGE axis of the de-escalated principal.
 *
 * `deEscalateUser` pins a real `maxAgeRating` (13 for an admin, whose own value
 * is null) while keeping `isAgeRestricted` false, so `runAssistant` does not
 * refuse the caller. That ceiling then has to survive all the way into the
 * queries. The taste-prefetch call hardcoded `age: { kind: 'any' }`, so the
 * plugin bridge received recently-watched titles ABOVE its own ceiling — the
 * `deEscalateUser` unit tests could not see it, because they stop at the
 * principal and never look at the boundary a query is handed.
 */
describe('runAssistant restricted-mode age ceiling', () => {
    beforeEach(() => {
        recentWatchedSpy.mockClear();
    });

    it("does not prefetch the asker's taste at all (nothing for a ceiling to leak through)", async () => {
        // The plugin bridge answers a shared room, so its prompt must carry none
        // of the viewer's ratings or watch history. The age-ceiling fix this
        // test used to pin (the prefetch ignoring the de-escalated ceiling) is
        // closed by not reading the rows, not by filtering them.
        await runAssistant(
            { message: 'what should I watch?' },
            {
                user: adminUser,
                sql: {} as never,
                restricted: true,
            },
        );

        expect(recentWatchedSpy).not.toHaveBeenCalled();
    });

    it('control: an unrestricted admin still has no age ceiling to apply', async () => {
        // Pins that the assertion above tracks de-escalation and not a constant:
        // the same viewer without `restricted` keeps maxAgeRating null, so the
        // real boundary genuinely is `any` there.
        await runAssistant(
            { message: 'what should I watch?' },
            {
                user: adminUser,
                sql: {} as never,
                restricted: false,
            },
        );

        const params = recentWatchedSpy.mock.calls[0][1] as { access: { age: unknown } };
        expect(params.access.age).toEqual({ kind: 'any' });
    });
});

/**
 * Server-side conversation compaction (Section C). Keeps the most-recent turns
 * within both caps (never splitting a turn, always ≥2 turns), and — for the
 * 'summarize' strategy — condenses dropped turns via ONE provider call, falling
 * back to plain truncation on failure.
 */
const u = (content: string): { role: 'user'; content: string } => ({ role: 'user', content });
const a = (content: string): { role: 'assistant'; content: string } => ({
    role: 'assistant',
    content,
});

function summaryResult(text: string): ChatResult {
    return {
        text,
        toolCalls: [],
        providerRaw: {},
        usage: { inputTokens: 30, outputTokens: 12 },
        usageMissing: false,
    };
}

const makeProvider = (createChatImpl: ChatProvider['createChat']): ChatProvider => ({
    model: 'gpt-4o',
    supportsTools: () => true,
    createChat: createChatImpl,
    createChatStream: async () => {
        throw new Error('createChatStream should not be used by compaction');
    },
});

describe('compactConversationHistory', () => {
    const history = [u('q1'), a('a1'), u('q2'), a('a2'), u('q3')];

    it('truncate keeps the most-recent turns and never starts the window on an assistant turn', async () => {
        const res = await compactConversationHistory(history, {
            maxTurns: 2,
            maxChars: 100000,
            strategy: 'truncate',
            provider: makeProvider(async () => {
                throw new Error('must not summarize in truncate mode');
            }),
        });
        // maxTurns 2 lands the window on ['a2','q3']; the leading assistant
        // turn is shifted out (Anthropic: first message must be a user turn).
        expect(res.history.map((t) => t.content)).toEqual(['q3']);
        expect(res.history[0].role).toBe('user');
        expect(res.extraTokens).toBe(0);
    });

    it('keeps a user-first window intact within the turn cap', async () => {
        const res = await compactConversationHistory(history, {
            maxTurns: 3,
            maxChars: 100000,
            strategy: 'truncate',
            provider: makeProvider(async () => {
                throw new Error('must not summarize in truncate mode');
            }),
        });
        // maxTurns 3 lands on ['q2','a2','q3'] — already user-first, untouched.
        expect(res.history.map((t) => t.content)).toEqual(['q2', 'a2', 'q3']);
    });

    it('char-cap window is normalized to user-first even when that shrinks the kept pair', async () => {
        const big = [u('x'.repeat(100)), a('y'.repeat(100)), u('z'.repeat(100))];
        const res = await compactConversationHistory(big, {
            maxTurns: 20,
            maxChars: 10, // far below a single turn
            strategy: 'truncate',
            provider: makeProvider(async () => summaryResult('nope')),
        });
        expect(res.history.map((t) => t.content)).toEqual(['z'.repeat(100)]);
    });

    it('summarize MERGES the summary into the first kept user turn (no adjacent user turns)', async () => {
        const createChat = vi.fn(async () =>
            summaryResult('User likes noir thrillers; asked about Heat.'),
        );
        const res = await compactConversationHistory(history, {
            maxTurns: 2,
            maxChars: 100000,
            strategy: 'summarize',
            provider: makeProvider(createChat),
        });
        expect(createChat).toHaveBeenCalledTimes(1);
        // Merged, not a separate synthetic turn — two adjacent user turns
        // violate Anthropic's role-alternation rule and 400 the reply.
        expect(res.history).toEqual([
            {
                role: 'user',
                content:
                    '[Summary of earlier conversation]\nUser likes noir thrillers; asked about Heat.\n\nq3',
            },
        ]);
        expect(res.extraTokens).toBe(42);
    });

    it('summarize skips the provider call when normalization empties the window', async () => {
        const createChat = vi.fn(async () => summaryResult('should not be called'));
        const res = await compactConversationHistory([a('orphan assistant turn')], {
            maxTurns: 20,
            maxChars: 100000,
            strategy: 'summarize',
            provider: makeProvider(createChat),
        });
        expect(res.history).toEqual([]);
        expect(createChat).not.toHaveBeenCalled();
        expect(res.extraTokens).toBe(0);
    });

    it('summarize falls back to plain truncation when the summary call throws', async () => {
        const res = await compactConversationHistory(history, {
            maxTurns: 2,
            maxChars: 100000,
            strategy: 'summarize',
            provider: makeProvider(async () => {
                throw new Error('provider down');
            }),
        });
        expect(res.history.map((t) => t.content)).toEqual(['q3']);
        expect(res.extraTokens).toBe(0);
    });

    it('returns history unchanged when nothing needs dropping', async () => {
        const short = [u('only1'), a('only2')];
        const res = await compactConversationHistory(short, {
            maxTurns: 20,
            maxChars: 100000,
            strategy: 'summarize',
            provider: makeProvider(async () => {
                throw new Error('must not summarize when nothing dropped');
            }),
        });
        expect(res.history).toEqual(short);
        expect(res.extraTokens).toBe(0);
    });
});

describe('buildRecommendedMovies numeric coercion (prod SSE 500 regression)', () => {
    // postgres.js returns CAST(... AS NUMERIC) columns as STRINGS and `date`
    // columns as Date objects. The old JSON path never validated in prod
    // (typedJson short-circuits), but the SSE `done` payload is schema-checked
    // — string ratings 500'd on prod (2026-07-04). Cards must parse cleanly.
    it('coerces numeric-string ratings and Date release dates from DB rows', async () => {
        const { RecommendedMovieSchema } = await import('$lib/schemas/assistant-types.js');
        const rows = [
            {
                media_id: '11111111-1111-1111-1111-111111111111',
                primary_ext_id: '550',
                media_type: 'movie',
                title: 'Quiet Orbit',
                overview: 'ok',
                genres: [18],
                imdb_rating: '8.8',
                rt_rating: '79',
                rt_audience_score: '96',
                runtime_minutes: '139',
                release_date: new Date('1999-10-15T00:00:00Z'),
                user_rating: '9',
                is_available: true,
                can_request: false,
            },
        ] as never;

        const [card] = buildRecommendedMovies(rows);
        const parsed = RecommendedMovieSchema.safeParse(card);
        expect(parsed.success).toBe(true);
        expect(card.imdbRating).toBe(8.8);
        expect(card.rtRating).toBe(79);
        // No tmdbRating: nothing in this pipeline writes `tmdb_rating` (TMDB's
        // own value is `vote_average` on a provider row these queries never
        // select), so the card field is left unset rather than always-null.
        expect(card.tmdbRating).toBeUndefined();
        expect(card.runtimeMinutes).toBe(139);
        expect(card.userRating).toBe(9);
        expect(card.releaseDate).toBe('1999-10-15');
    });

    it('maps null/garbage numerics to undefined instead of failing validation', async () => {
        const { RecommendedMovieSchema } = await import('$lib/schemas/assistant-types.js');
        const rows = [
            {
                media_id: '22222222-2222-2222-2222-222222222222',
                media_type: 'tv',
                title: 'Untitled',
                overview: null,
                genres: null,
                imdb_rating: null,
                rt_rating: 'NaN',
                tmdb_rating: undefined,
                runtime_minutes: 'not-a-number',
                release_date: null,
                user_rating: null,
                is_available: false,
                can_request: false,
            },
        ] as never;

        const [card] = buildRecommendedMovies(rows);
        expect(RecommendedMovieSchema.safeParse(card).success).toBe(true);
        expect(card.imdbRating).toBeUndefined();
        expect(card.rtRating).toBeUndefined();
        expect(card.runtimeMinutes).toBeUndefined();
        expect(card.releaseDate).toBeUndefined();
    });
});

describe('buildRecommendedMovies — watch link (no Jellyfin deep link)', () => {
    const row = {
        media_id: '33333333-3333-3333-3333-333333333333',
        media_type: 'movie',
        title: 'Linked',
        is_available: true,
        can_request: false,
    };

    it('uses the internal watch route even while Jellyfin sync is on', async () => {
        const { features } = await import('$lib/server/config');
        (features as { jellyfinSync: boolean }).jellyfinSync = true;
        publicEnv.PUBLIC_JELLYFINURL = 'https://jf.example';
        const [card] = buildRecommendedMovies([row] as never);
        expect(card.actionUrl).toBe(`/watch/${row.media_id}`);
        delete publicEnv.PUBLIC_JELLYFINURL;
    });

    it('keeps the internal watch route when Jellyfin sync is off', async () => {
        const { features } = await import('$lib/server/config');
        (features as { jellyfinSync: boolean }).jellyfinSync = false;
        publicEnv.PUBLIC_JELLYFINURL = 'https://jf.example';
        const [card] = buildRecommendedMovies([row] as never);
        expect(card.actionUrl).toBe(`/watch/${row.media_id}`);
        (features as { jellyfinSync: boolean }).jellyfinSync = true;
        delete publicEnv.PUBLIC_JELLYFINURL;
    });
});
