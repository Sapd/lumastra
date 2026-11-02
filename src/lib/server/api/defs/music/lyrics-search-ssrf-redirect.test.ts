// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end SSRF redirect-pivot test for defs/music/lyrics-search.ts.
 *
 * The def embeds the query via `generateVoyageQueryEmbedding` (ai/voyage.ts),
 * which — outside a task-scoped `runWithEmbeddingFetch` run, i.e. exactly
 * this interactive path — builds its Voyage SDK client with
 * `guardedDefaultFetch`. With `EMBEDDING_ALLOW_PRIVATE_URLS` at its default
 * (false), `guardedDefaultFetch` delegates to `safeFetch`
 * (tasks/url-safety.ts), the public-only, per-hop-revalidating guard. See
 * `embedding-fetch-context.ts`'s file doc and `voyage.ts`'s
 * `guardedDefaultFetch` comment — a prior brief in this security-review
 * series MISNAMED this call chain, so this file was written by tracing the
 * actual imports rather than assuming a "lyrics provider" fetch.
 *
 * `safeFetch`'s redirect-pivot defense (re-validating every hop, including
 * 3xx targets) already has exhaustive unit coverage in url-safety.test.ts.
 * What is missing — and what this file adds — is END-TO-END proof that the
 * def is actually WIRED to that guard: a malicious/compromised provider
 * response redirecting to `127.0.0.1` must make the whole def request fail
 * closed (503, not a hang or a leaked internal response), and the loopback
 * target must never receive a request.
 *
 * Mocks `node:dns` and `undici` exactly like url-safety.test.ts (so the real
 * `safeFetch` DNS-rebinding + redirect-revalidation logic runs unmodified);
 * `generateVoyageQueryEmbedding` and the Voyage SDK are NOT mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── node:dns / undici mocks (mirrors url-safety.test.ts) ───────────────────

const dnsLookupMock = vi.fn();
vi.mock('node:dns', () => ({
    promises: {
        lookup: (...args: unknown[]) => dnsLookupMock(...args),
    },
}));

const undiciFetchMock = vi.fn();
vi.mock('undici', () => ({
    Agent: class {
        constructor() {}
        close(): Promise<void> {
            return Promise.resolve();
        }
    },
    fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

// safeFetch takes the undici (pinned) path only when the hop's host resolves
// via DNS; an IP-LITERAL hop (like the 127.0.0.1 redirect target here) has no
// resolved addresses to pin and instead falls through to the global `fetch`.
// If a redirect-pivot bug ever let a private-IP hop through unguarded, THIS
// mock — not undiciFetchMock — is what would receive it, so it must be
// tracked independently rather than assumed unreachable.
const globalFetchMock = vi.fn();
const realGlobalFetch = globalThis.fetch;

function mkResponse(status: number, body: unknown, location?: string): Response {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (location) headers.set('location', location);
    return new Response(JSON.stringify(body), { status, headers });
}

// ── Def dependency mocks (everything except the embedding/fetch path) ──────

const mockGetSql = vi.fn();
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

const mockBuildSearchAccessContext = vi.fn();
const mockSearchByLyricsEmbedding = vi.fn();
vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    };
});
vi.mock('$lib/server/database/queries/lyrics-search.queries.js', () => ({
    searchByLyricsEmbedding: (...args: unknown[]) => mockSearchByLyricsEmbedding(...args),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// VOYAGE_API_KEY set so isVoyageAvailable()/getVoyageClient() take the real
// (non-custom-endpoint) Voyage path. EMBEDDING_ALLOW_PRIVATE_URLS is mutated
// per-test (see mockConfigOverrides below) — getAiConfig() reads it fresh on
// every call, so flipping it between tests genuinely switches which guard
// (safeFetch vs fetchWithTimeout) guardedDefaultFetch delegates to.
const mockFeatures: Record<string, unknown> = { lyricsSearch: true };
const mockConfigOverrides: Record<string, unknown> = {
    VOYAGE_API_KEY: 'test-voyage-key',
    EMBEDDING_API_KEY: undefined,
    EMBEDDING_BASE_URL: undefined,
    OPENAI_API_KEY: undefined,
    EMBEDDING_ALLOW_PRIVATE_URLS: false,
};
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        features: mockFeatures,
        config: new Proxy(actual.config, {
            get: (target, prop: string) =>
                prop in mockConfigOverrides ? mockConfigOverrides[prop] : target[prop as never],
        }),
    };
});

const mockCheckRateLimit = vi.fn();
vi.mock('$lib/server/middleware/valkey-rate-limit.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/middleware/valkey-rate-limit.js')>();
    return {
        ...actual,
        checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    };
});

// ── Import def AFTER mocks ──────────────────────────────────────────────────

const { def } = await import('./lyrics-search.js');

function makeEvent(q: string): RequestEvent {
    const url = new URL('http://localhost/api/v1/music/lyrics-search');
    url.searchParams.set('q', q);
    return {
        url,
        params: {},
        route: { id: '/api/v1/music/lyrics-search' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: 'usr_00000000-0000-0000-0000-000000000001',
                username: 'alice',
                groups: '',
                userGroups: [],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
            principal: undefined,
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const CTX = { surface: 'v1' as const };
const GET = def.handlers.GET!;

beforeEach(() => {
    dnsLookupMock.mockReset();
    undiciFetchMock.mockReset();
    globalFetchMock.mockReset();
    // A malicious/compromised loopback target actually answering — if the
    // guard ever failed to refuse the redirect, this is what "success" would
    // look like, so the mock must return something a real internal endpoint
    // plausibly would, not an error that would fail closed for an unrelated
    // reason.
    globalFetchMock.mockResolvedValue(
        mkResponse(200, {
            object: 'list',
            data: [{ object: 'embedding', embedding: Array(1024).fill(0.02), index: 0 }],
            model: 'voyage-3-large',
            usage: { total_tokens: 3 },
        }),
    );
    globalThis.fetch = globalFetchMock as unknown as typeof fetch;
    mockGetSql.mockReset().mockReturnValue({});
    mockBuildSearchAccessContext.mockReset().mockResolvedValue({
        userId: 'usr_1',
        libraryGroupIds: null,
        maxAgeRating: null,
        isAgeRestricted: false,
    });
    mockSearchByLyricsEmbedding.mockReset();
    mockCheckRateLimit.mockReset().mockResolvedValue({ allowed: true, resetAt: 0 });
    mockConfigOverrides.EMBEDDING_ALLOW_PRIVATE_URLS = false;
});

afterEach(() => {
    globalThis.fetch = realGlobalFetch;
});

describe('SSRF redirect-pivot: lyrics-search embedding call refuses a 307 to 127.0.0.1', () => {
    it('a provider response that 307s to http://127.0.0.1/... is refused end-to-end (503), and the loopback target is never requested', async () => {
        // Voyage's real API host resolves publicly — the attack is the
        // RESPONSE (a compromised/malicious provider or on-path attacker),
        // not the DNS entry.
        dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        undiciFetchMock.mockResolvedValue(
            mkResponse(307, null, 'http://127.0.0.1/admin/internal-secret'),
        );

        const response = await GET(makeEvent('sunshine and rain'), CTX);

        expect(response.status).toBe(503);
        // The redirect hop was issued (to the real, public-resolving Voyage
        // host), but the 127.0.0.1 Location must never be requested through
        // EITHER transport the guard could use for it: undici (pinned/DNS
        // path) or the global fetch (unpinned/IP-literal path).
        expect(undiciFetchMock).toHaveBeenCalled();
        for (const call of undiciFetchMock.mock.calls) {
            const requestedUrl = String((call as unknown[])[0]);
            expect(requestedUrl).not.toContain('127.0.0.1');
        }
        expect(globalFetchMock).not.toHaveBeenCalled();
        // The redirect-pivot must be refused before any DB search runs.
        expect(mockSearchByLyricsEmbedding).not.toHaveBeenCalled();
    });

    it('control: a well-behaved (non-redirecting) provider response is accepted and the search proceeds', async () => {
        dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        const dimension = 1024;
        undiciFetchMock.mockResolvedValue(
            mkResponse(200, {
                object: 'list',
                data: [{ object: 'embedding', embedding: Array(dimension).fill(0.01), index: 0 }],
                model: 'voyage-3-large',
                usage: { total_tokens: 3 },
            }),
        );
        mockSearchByLyricsEmbedding.mockResolvedValue([]);

        const response = await GET(makeEvent('sunshine and rain'), CTX);

        // Whatever the exact configured dimension is, a genuine 200 from the
        // (public, non-redirecting) provider must NOT be refused the way the
        // 307-to-loopback case above is — proving the 503 above is really
        // about the redirect, not an unrelated config/mock gap.
        expect(response.status).not.toBe(503);
    });

    it('EMBEDDING_ALLOW_PRIVATE_URLS=true does NOT reopen the redirect-pivot: the same cross-origin 307 is still refused', async () => {
        // Opting in to private targets switches guardedDefaultFetch from
        // safeFetch to fetchWithTimeout's same-origin-only redirect policy
        // (embedding-fetch-context.ts / voyage.ts doc comments) — this exists
        // to let a self-hosted EMBEDDING_BASE_URL on a LAN address work, not
        // to let the REAL public Voyage endpoint redirect a caller somewhere
        // else entirely. fetchWithTimeout goes through the global `fetch`,
        // not undici, so this exercises globalFetchMock end to end.
        mockConfigOverrides.EMBEDDING_ALLOW_PRIVATE_URLS = true;
        globalFetchMock.mockImplementation(async (input: unknown) => {
            const url = String(input);
            if (url.includes('127.0.0.1')) {
                // What a "successful pivot" would look like, if it happened.
                return mkResponse(200, {
                    object: 'list',
                    data: [{ object: 'embedding', embedding: Array(1024).fill(0.02), index: 0 }],
                    model: 'voyage-3-large',
                    usage: { total_tokens: 3 },
                });
            }
            return mkResponse(307, null, 'http://127.0.0.1/admin/internal-secret');
        });

        const response = await GET(makeEvent('sunshine and rain'), CTX);

        expect(response.status).toBe(503);
        expect(mockSearchByLyricsEmbedding).not.toHaveBeenCalled();
        // The loopback URL must never actually be requested — only the
        // original (cross-origin) hop is.
        for (const call of globalFetchMock.mock.calls) {
            const requestedUrl = String((call as unknown[])[0]);
            expect(requestedUrl).not.toContain('127.0.0.1');
        }
    });
});
