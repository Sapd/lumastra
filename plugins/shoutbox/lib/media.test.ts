// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { enrichChips, sanitizeOutgoing, linkifyMediaUrls } from './media.js';
import { makeToken } from './tokens.js';

// Real 36-char UUIDs — the hardened token format only round-trips uuid ids.
const U1 = '00000000-0000-0000-0000-000000000001';
const KEEP = '11111111-1111-1111-1111-111111111111';
const DROP = '22222222-2222-2222-2222-222222222222';

const ctx = (chips: unknown[]) =>
    ({ media: { resolveForViewer: vi.fn(async () => chips) } }) as never;

describe('media enrichment', () => {
    it('enrichChips maps tokens to a per-viewer chip map', async () => {
        const body = `see ${makeToken(U1, 'movie')}`;
        const c = ctx([
            { id: U1, mediaType: 'movie', allowed: true, title: 'Haze', openHref: `?modal=${U1}` },
        ]);
        const { chips } = await enrichChips(c, body);
        expect(chips[`${U1}:movie`].allowed).toBe(true);
    });
    it('enrichChips keeps denied chips in the map with allowed=false (viewer renders them inert, not missing)', async () => {
        const body = `see ${makeToken(DROP, 'tv')}`;
        const c = ctx([{ id: DROP, mediaType: 'tv', allowed: false }]);
        const { chips } = await enrichChips(c, body);
        // Security contract: denied entries must survive enrichment so the widget
        // renders an inert chip rather than silently dropping it.
        expect(chips[`${DROP}:tv`]).toBeDefined();
        expect(chips[`${DROP}:tv`].allowed).toBe(false);
    });
    it('sanitizeOutgoing strips tokens the author cannot see', async () => {
        const body = `${makeToken(KEEP, 'movie')} ${makeToken(DROP, 'tv')}`;
        const c = ctx([
            { id: KEEP, mediaType: 'movie', allowed: true, title: 'K', openHref: `?modal=${KEEP}` },
            { id: DROP, mediaType: 'tv', allowed: false },
        ]);
        const out = await sanitizeOutgoing(c, body);
        expect(out).toContain(KEEP);
        expect(out).not.toContain(DROP);
    });
});

describe('linkifyMediaUrls (paste-a-link → chip)', () => {
    // A ctx where getById knows `known` ids (→ type), and resolveForViewer marks
    // `allowed` ids accessible. Spies let us assert lookup counts (DoS/dedupe).
    function linkCtx(opts: {
        known?: Record<string, string>; // id -> mediaType
        allowed?: Set<string>; // ids the author may see
    }) {
        const known = opts.known ?? {};
        const allowed = opts.allowed ?? new Set();
        const getById = vi.fn(async (id: string) => {
            const mt = known[id.toLowerCase()];
            return mt
                ? {
                      id,
                      title: 'X',
                      year: null,
                      mediaType: mt,
                      overview: null,
                      libraryAddedAt: null,
                  }
                : null;
        });
        const resolveForViewer = vi.fn(async (refs: Array<{ id: string; mediaType: string }>) =>
            refs.map((r) => ({
                id: r.id,
                mediaType: r.mediaType,
                allowed: allowed.has(r.id.toLowerCase()),
                ...(allowed.has(r.id.toLowerCase())
                    ? { title: 'X', openHref: `?modal=${r.id}` }
                    : {}),
            })),
        );
        return {
            ctx: { mediaItems: { getById }, media: { resolveForViewer } } as never,
            getById,
            resolveForViewer,
        };
    }

    it('converts a ?modal=<uuid> link to a token when the author has access', async () => {
        const { ctx } = linkCtx({ known: { [U1]: 'movie' }, allowed: new Set([U1]) });
        const out = await linkifyMediaUrls(ctx, `watch this https://example.com/?modal=${U1} now`);
        expect(out).toBe(`watch this ${makeToken(U1, 'movie')} now`);
    });

    it('converts a /watch/<uuid> link too', async () => {
        const { ctx } = linkCtx({ known: { [U1]: 'tv' }, allowed: new Set([U1]) });
        const out = await linkifyMediaUrls(ctx, `https://example.com/watch/${U1}`);
        expect(out).toBe(makeToken(U1, 'tv'));
    });

    it('is host-agnostic (relative ?modal= link, no scheme/host) and matches uppercase UUIDs', async () => {
        const up = U1.toUpperCase();
        const { ctx } = linkCtx({ known: { [U1]: 'movie' }, allowed: new Set([U1]) });
        const out = await linkifyMediaUrls(ctx, `/?modal=${up}`);
        expect(out).toBe(makeToken(U1, 'movie')); // normalized to lowercase token
    });

    it('SECURITY: leaves the URL as plain text when the author CANNOT access it (no token, no leak)', async () => {
        const { ctx } = linkCtx({ known: { [DROP]: 'movie' }, allowed: new Set() /* none */ });
        const url = `https://example.com/?modal=${DROP}`;
        const out = await linkifyMediaUrls(ctx, `psst ${url}`);
        expect(out).toBe(`psst ${url}`); // unchanged
        expect(out).not.toContain('{{media:');
    });

    it('leaves the URL untouched for an unknown/non-existent id', async () => {
        const { ctx, resolveForViewer } = linkCtx({ known: {} /* getById → null */ });
        const url = `https://example.com/?modal=${U1}`;
        const out = await linkifyMediaUrls(ctx, url);
        expect(out).toBe(url);
        expect(resolveForViewer).not.toHaveBeenCalled(); // nothing to resolve
    });

    it('ignores non-media URLs entirely', async () => {
        const { ctx, getById } = linkCtx({ known: { [U1]: 'movie' }, allowed: new Set([U1]) });
        const out = await linkifyMediaUrls(
            ctx,
            'see https://example.com/movies/heat and /settings',
        );
        expect(out).toBe('see https://example.com/movies/heat and /settings');
        expect(getById).not.toHaveBeenCalled();
    });

    it('does NOT convert a composite ?modal=tmdb:550:movie link (only internal UUIDs)', async () => {
        const { ctx, getById } = linkCtx({ known: {}, allowed: new Set() });
        const out = await linkifyMediaUrls(ctx, 'https://example.com/?modal=tmdb:550:movie');
        expect(out).toBe('https://example.com/?modal=tmdb:550:movie');
        expect(getById).not.toHaveBeenCalled();
    });

    it('dedupes repeated identical links (one lookup) and converts all occurrences', async () => {
        const { ctx, getById } = linkCtx({ known: { [U1]: 'movie' }, allowed: new Set([U1]) });
        const out = await linkifyMediaUrls(ctx, `/?modal=${U1} and again /?modal=${U1}`);
        expect(getById).toHaveBeenCalledTimes(1); // deduped
        expect(out).toBe(`${makeToken(U1, 'movie')} and again ${makeToken(U1, 'movie')}`);
    });

    it('handles multiple distinct accessible links in one message', async () => {
        const { ctx } = linkCtx({
            known: { [U1]: 'movie', [KEEP]: 'tv' },
            allowed: new Set([U1, KEEP]),
        });
        const out = await linkifyMediaUrls(ctx, `a /?modal=${U1} b /watch/${KEEP} c`);
        expect(out).toBe(`a ${makeToken(U1, 'movie')} b ${makeToken(KEEP, 'tv')} c`);
    });

    it('caps distinct lookups at 12 (DoS guard) — extra links stay as URLs', async () => {
        const ids = Array.from(
            { length: 15 },
            (_, i) => `${String(i + 10).padStart(8, '0')}-0000-0000-0000-000000000000`,
        );
        const known: Record<string, string> = {};
        for (const id of ids) known[id] = 'movie';
        const { ctx, getById } = linkCtx({ known, allowed: new Set(ids) });
        const body = ids.map((id) => `/?modal=${id}`).join(' ');
        const out = await linkifyMediaUrls(ctx, body);
        expect(getById.mock.calls.length).toBeLessThanOrEqual(12);
        // first 12 converted, last 3 left as URLs
        expect((out.match(/\{\{media:/g) || []).length).toBe(12);
    });

    it('returns the body unchanged when ctx.media / ctx.mediaItems is missing', async () => {
        const body = `/?modal=${U1}`;
        expect(
            await linkifyMediaUrls({ media: { resolveForViewer: vi.fn() } } as never, body),
        ).toBe(body);
        expect(await linkifyMediaUrls({ mediaItems: { getById: vi.fn() } } as never, body)).toBe(
            body,
        );
        expect(await linkifyMediaUrls(undefined as never, body)).toBe(body);
    });

    it('returns non-string input as-is (no throw)', async () => {
        const { ctx } = linkCtx({});
        expect(await linkifyMediaUrls(ctx, null as never)).toBe(null);
        expect(await linkifyMediaUrls(ctx, 123 as never)).toBe(123);
    });

    it('fails closed (keeps URLs) when getById / resolveForViewer throw', async () => {
        const url = `/?modal=${U1}`;
        const throwingGet = {
            mediaItems: {
                getById: vi.fn(async () => {
                    throw new Error('db down');
                }),
            },
            media: { resolveForViewer: vi.fn(async () => []) },
        } as never;
        expect(await linkifyMediaUrls(throwingGet, url)).toBe(url);
        const throwingResolve = {
            mediaItems: { getById: vi.fn(async () => ({ id: U1, mediaType: 'movie' })) },
            media: {
                resolveForViewer: vi.fn(async () => {
                    throw new Error('boom');
                }),
            },
        } as never;
        expect(await linkifyMediaUrls(throwingResolve, url)).toBe(url);
    });
});
