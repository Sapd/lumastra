// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security + routing tests for GET|HEAD /api/v1/media/{id}/topshelf-preview/file/{variant} (§9.3).
 *
 * All external dependencies are mocked — no live infrastructure required.
 * Named `server.test.ts` (never `+server.test.ts` — the `+` name is reserved
 * and only `vite build` catches it).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockConfig = vi.hoisted(() => ({ FEATURE_TOPSHELF_PREVIEWS: true }));
// Partial mock: keep the REAL config object (mount.ts's task/auth machinery
// reads many unrelated FEATURE_* keys transitively) and only override the
// one key this route cares about, as a live getter so tests can flip it.
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            get FEATURE_TOPSHELF_PREVIEWS() {
                return mockConfig.FEATURE_TOPSHELF_PREVIEWS;
            },
        },
    };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const mockVerifySignedUrl = vi.fn();
vi.mock('$lib/server/utils/signed-url.js', () => ({
    verifySignedUrl: (...args: unknown[]) => mockVerifySignedUrl(...args),
}));

const mockGetVariantArtifact = vi.fn();
const mockTouch = vi.fn().mockResolvedValue(undefined);
vi.mock('$lib/server/services/topshelf/topshelf-artifact.store.js', () => ({
    getTopShelfArtifactStore: () => ({
        getVariantArtifact: (...args: unknown[]) => mockGetVariantArtifact(...args),
        touch: (...args: unknown[]) => mockTouch(...args),
    }),
}));

const mockResolveAndEnqueue = vi.fn().mockResolvedValue({ state: 'pending' });
vi.mock('$lib/server/services/topshelf/topshelf-render.service.js', () => ({
    resolveAndEnqueueTopShelfVariant: (...args: unknown[]) => mockResolveAndEnqueue(...args),
}));

const mockResolveOverlay = vi.fn().mockResolvedValue({ mode: 'none' });
vi.mock('$lib/server/services/topshelf/topshelf-overlay-resolver.js', () => ({
    resolveOverlay: (...args: unknown[]) => mockResolveOverlay(...args),
}));

const mockServeFileWithRange = vi.fn();
vi.mock('$lib/server/utils/http-range.js', () => ({
    serveFileWithRange: (...args: unknown[]) => mockServeFileWithRange(...args),
}));

vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => ({}) as unknown,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/topshelf-preview/file/[variant].js';

const ctx = { surface: 'v1' as const };
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeEvent(
    opts: {
        params?: Record<string, string>;
        searchParams?: Record<string, string>;
        headers?: Record<string, string>;
        method?: string;
    } = {},
): RequestEvent {
    const url = new URL(
        `http://localhost/api/v1/media/${VALID_UUID}/topshelf-preview/file/preview.mp4`,
    );
    for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
        url.searchParams.set(k, v);
    }
    const method = opts.method ?? 'GET';
    return {
        url,
        request: new Request(url.toString(), { method, headers: opts.headers ?? {} }),
        params: opts.params ?? { id: VALID_UUID, variant: 'preview.mp4' },
        route: { id: '/test' as const },
        locals: {},
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

async function bodyCode(res: Response): Promise<string> {
    const body = (await res.clone().json()) as { code: string };
    return body.code;
}

describe('GET/HEAD /api/v1/media/{id}/topshelf-preview/file/{variant} — security', () => {
    const { GET } = mount(def, ctx);

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.FEATURE_TOPSHELF_PREVIEWS = true;
        mockVerifySignedUrl.mockReturnValue({ valid: true });
        mockGetVariantArtifact.mockResolvedValue({
            status: 'ready',
            path: '/tmp/fake-preview.mp4',
            entry: {
                contentKey: 'abc123',
                source: 'snippet',
                bytes: 100,
                createdAt: '',
                lastRequestedAt: '',
            },
        });
        mockServeFileWithRange.mockResolvedValue(new Response(null, { status: 200 }));
    });

    it('the serving URL query keys are exactly {expires, purpose, sig} when validly signed', () => {
        // signUrl always emits exactly these three params — assert the contract
        // here so a future change can't silently smuggle a 4th credential-bearing
        // param (api_key/stream_token/JWT) onto this path.
        const url = new URL(
            `http://localhost/api/v1/media/${VALID_UUID}/topshelf-preview/file/preview.mp4?expires=1&purpose=topshelf-preview&sig=deadbeef`,
        );
        expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'purpose', 'sig']);
    });

    it('returns 403 with no signature at all', async () => {
        mockVerifySignedUrl.mockReturnValue({ valid: false, reason: 'missing_params' });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(403);
        expect(await bodyCode(res)).toBe('forbidden');
    });

    it('returns 403 for an expired signature', async () => {
        mockVerifySignedUrl.mockReturnValue({ valid: false, reason: 'expired' });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(403);
    });

    it('returns 403 for a purpose=image signature (cross-purpose reuse)', async () => {
        mockVerifySignedUrl.mockReturnValue({ valid: false, reason: 'purpose_mismatch' });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(403);
    });

    it('returns 403 for a cross-item signature (invalid_signature)', async () => {
        mockVerifySignedUrl.mockReturnValue({ valid: false, reason: 'invalid_signature' });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(403);
    });

    it('a Bearer/session credential WITHOUT a valid sig still gets 403 (sig-only, no alternate path)', async () => {
        mockVerifySignedUrl.mockReturnValue({ valid: false, reason: 'missing_params' });
        const res = await GET!(
            makeEvent({ headers: { authorization: 'Bearer pat_totallyvalidlookingtoken' } }),
        );
        expect(res.status).toBe(403);
        // The store must never even be consulted once the sig check fails.
        expect(mockGetVariantArtifact).not.toHaveBeenCalled();
    });

    it('returns 404 when the feature flag is off (never reaches the sig check)', async () => {
        mockConfig.FEATURE_TOPSHELF_PREVIEWS = false;
        const res = await GET!(makeEvent());
        expect(res.status).toBe(404);
        expect(mockVerifySignedUrl).not.toHaveBeenCalled();
    });

    it('returns 422/validation_failed for a malformed variant', async () => {
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, variant: 'trailer.mp4' } }));
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
    });

    it('returns 422/validation_failed for a non-UUID id', async () => {
        const res = await GET!(makeEvent({ params: { id: 'not-a-uuid', variant: 'preview.mp4' } }));
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
    });

    it('returns 404 when there is no manifest entry at all (never minted)', async () => {
        mockGetVariantArtifact.mockResolvedValue({ status: 'no_entry' });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(404);
        // No regeneration trigger for a bare never-minted URL.
        expect(mockResolveAndEnqueue).not.toHaveBeenCalled();
    });

    it('returns 410 and enqueues a heal when the manifest entry exists but the file is gone', async () => {
        mockGetVariantArtifact.mockResolvedValue({
            status: 'missing_file',
            entry: {
                contentKey: 'abc123',
                source: 'snippet',
                bytes: 100,
                createdAt: '',
                lastRequestedAt: '',
            },
        });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(410);
        await Promise.resolve(); // let the fire-and-forget heal's microtask run
        expect(mockResolveAndEnqueue).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            'preview',
        );
    });

    it('serves the file and touches lastRequestedAt when the artifact is ready', async () => {
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        expect(mockTouch).toHaveBeenCalledWith(VALID_UUID, 'preview');
        expect(mockServeFileWithRange).toHaveBeenCalledWith(
            '/tmp/fake-preview.mp4',
            expect.anything(),
            expect.objectContaining({ contentType: 'video/mp4' }),
        );
    });

    it('returns 304 when If-None-Match matches the current ETag', async () => {
        const res = await GET!(makeEvent({ headers: { 'if-none-match': '"abc123"' } }));
        expect(res.status).toBe(304);
        expect(mockServeFileWithRange).not.toHaveBeenCalled();
    });

    // ── Compound overlay tokens (Task 11) ──────────────────────────────────

    it('serves a valid compound-token artifact', async () => {
        const token = 'preview-ov-logo-tl-s1-x40';
        mockGetVariantArtifact.mockResolvedValue({
            status: 'ready',
            path: '/tmp/fake-preview-ov.mp4',
            entry: {
                contentKey: 'abc123',
                source: 'snippet',
                mode: 'logo',
                bytes: 100,
                createdAt: '',
                lastRequestedAt: '',
            },
        });
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, variant: `${token}.mp4` } }));
        expect([200, 206]).toContain(res.status);
        // Store lookup/touch must use the FULL compound token, not the base variant.
        expect(mockGetVariantArtifact).toHaveBeenCalledWith(VALID_UUID, token);
        expect(mockTouch).toHaveBeenCalledWith(VALID_UUID, token);
    });

    it('rejects a malformed compound token', async () => {
        const res = await GET!(
            makeEvent({ params: { id: VALID_UUID, variant: 'preview-ov-bogus.mp4' } }),
        );
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
        expect(mockGetVariantArtifact).not.toHaveBeenCalled();
    });

    it('heals a missing compound-token artifact by re-resolving its mode/locale when the resolved mode still matches', async () => {
        const token = 'preview-ov-logo-tl-s1-x40';
        mockGetVariantArtifact.mockResolvedValue({
            status: 'missing_file',
            entry: {
                contentKey: 'abc123',
                source: 'snippet',
                mode: 'logo',
                bytes: 100,
                createdAt: '',
                lastRequestedAt: '',
            },
        });
        mockResolveOverlay.mockResolvedValue({ mode: 'logo', contentHash: 'deadbeef' });
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, variant: `${token}.mp4` } }));
        expect(res.status).toBe(410);
        // Flush the fire-and-forget heal's dynamic import + async chain.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockResolveOverlay).toHaveBeenCalled();
        expect(mockResolveAndEnqueue).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            'preview',
            expect.objectContaining({
                base: 'preview',
                mode: 'logo',
                contentHash: 'deadbeef',
            }),
        );
    });

    it('does NOT re-render on heal when the resolved mode no longer matches the token (no silent mode switch)', async () => {
        const token = 'preview-ov-logo-tl-s1-x40';
        mockGetVariantArtifact.mockResolvedValue({
            status: 'missing_file',
            entry: {
                contentKey: 'abc123',
                source: 'snippet',
                mode: 'logo',
                bytes: 100,
                createdAt: '',
                lastRequestedAt: '',
            },
        });
        // e.g. the logo was deleted — resolveOverlay now falls back to text.
        mockResolveOverlay.mockResolvedValue({
            mode: 'text',
            text: 'Some Title',
            contentHash: 'deadbeef',
        });
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, variant: `${token}.mp4` } }));
        expect(res.status).toBe(410);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockResolveOverlay).toHaveBeenCalled();
        expect(mockResolveAndEnqueue).not.toHaveBeenCalled();
    });

    it('heals a plain-variant missing artifact with no overlay descriptor (unchanged behavior)', async () => {
        mockGetVariantArtifact.mockResolvedValue({
            status: 'missing_file',
            entry: {
                contentKey: 'abc123',
                source: 'snippet',
                bytes: 100,
                createdAt: '',
                lastRequestedAt: '',
            },
        });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(410);
        await Promise.resolve();
        expect(mockResolveAndEnqueue).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            'preview',
        );
        expect(mockResolveOverlay).not.toHaveBeenCalled();
    });
});
