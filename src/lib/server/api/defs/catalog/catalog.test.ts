// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the catalog domain defs.
 *
 * Tests focus on:
 *   - def.auth spec shape — assert that every def declares {kind: 'user'}
 *   - def.handlers keys — assert GET (and PUT for rating) are present
 *   - toPublicMediaType() — 'tv'/'show' → 'series' canonical type mapping
 *   - resolveInternalId() — UUID fast-path and composite-key rejection
 *
 * Auth enforcement and handler request flow are covered in mount.test.ts
 * and the integration tests; these tests target def-layer invariants only.
 */

import { describe, it, expect } from 'vitest';

// ── import defs ───────────────────────────────────────────────────────────────
// Direct imports from the def files (not through index) so each can be tested
// independently and without loading all dependencies.

// We import only the structure (auth + handler keys), not the handler bodies,
// to keep tests fast and dependency-free.  Handler bodies are integration-tested.

import { toPublicMediaType } from '$lib/server/utils/media-types.js';
import { def as mediaIdDef } from './media-id.js';
import { def as seriesIdDef } from './series-id.js';
import { def as mediaIdRatingDef } from './media-id-rating.js';
import { def as peopleIdDef } from './people-id.js';
import { resolveInternalId } from './media-id-rating.js';

// ── helpers ───────────────────────────────────────────────────────────────────

type AuthSpec = { kind: string };

function authKind(def: { auth: AuthSpec | Record<string, AuthSpec> }): string {
    if (typeof def.auth === 'object' && 'kind' in def.auth) {
        return (def.auth as AuthSpec).kind;
    }
    return '';
}

// Minimal fake RequestEvent for resolveInternalId
function fakeEvent(params: Record<string, string> = {}, resolvedId?: string) {
    return {
        params,
        locals: {
            resolvedIds: resolvedId ? { internalId: resolvedId } : undefined,
        },
    } as unknown as import('@sveltejs/kit').RequestEvent;
}

// ── def structure tests ───────────────────────────────────────────────────────

describe('mediaIdDef structure', () => {
    it('declares auth kind = user', () => {
        expect(authKind(mediaIdDef)).toBe('user');
    });

    it('has a GET handler', () => {
        expect(typeof mediaIdDef.handlers.GET).toBe('function');
    });

    it('does NOT have a POST handler', () => {
        expect(mediaIdDef.handlers.POST).toBeUndefined();
    });
});

describe('seriesIdDef structure', () => {
    it('declares auth kind = user', () => {
        expect(authKind(seriesIdDef)).toBe('user');
    });

    it('has a GET handler', () => {
        expect(typeof seriesIdDef.handlers.GET).toBe('function');
    });
});

describe('mediaIdRatingDef structure', () => {
    it('declares auth kind = user', () => {
        expect(authKind(mediaIdRatingDef)).toBe('user');
    });

    it('has a GET handler', () => {
        expect(typeof mediaIdRatingDef.handlers.GET).toBe('function');
    });

    it('has a PUT handler (rating write)', () => {
        expect(typeof mediaIdRatingDef.handlers.PUT).toBe('function');
    });

    it('has a DELETE handler (clears the rating, the only way a typed client can send "no rating")', () => {
        expect(typeof mediaIdRatingDef.handlers.DELETE).toBe('function');
    });
});

describe('peopleIdDef structure', () => {
    it('declares auth kind = user', () => {
        expect(authKind(peopleIdDef)).toBe('user');
    });

    it('has a GET handler', () => {
        expect(typeof peopleIdDef.handlers.GET).toBe('function');
    });
});

// ── resolveInternalId() ───────────────────────────────────────────────────────

describe('resolveInternalId()', () => {
    const UUID = '12345678-1234-1234-1234-123456789012';

    it('returns resolvedIds.internalId from middleware when present', () => {
        const event = fakeEvent({ id: 'any' }, UUID);
        expect(resolveInternalId(event)).toBe(UUID);
    });

    it('returns UUID from params when no middleware resolvedIds', () => {
        const event = fakeEvent({ id: UUID });
        expect(resolveInternalId(event)).toBe(UUID);
    });

    it('returns null for non-UUID composite key when no middleware', () => {
        const event = fakeEvent({ id: 'tmdb:12345:movie' });
        expect(resolveInternalId(event)).toBeNull();
    });

    it('returns null for empty id param and no middleware', () => {
        const event = fakeEvent({ id: '' });
        expect(resolveInternalId(event)).toBeNull();
    });

    it('is case-insensitive for UUID hex chars', () => {
        const upperUuid = UUID.toUpperCase();
        const event = fakeEvent({ id: upperUuid });
        expect(resolveInternalId(event)).toBe(upperUuid);
    });
});

// ── toPublicMediaType ─────────────────────────────────────────────────────────

/**
 * `toPublicMediaType` is the shared public-boundary mapper
 * ($lib/shared/media-types, re-exported via server/utils/media-types). These
 * cases pin the canonical mapping contract the catalog spine relies on.
 */
describe('type mapping — toPublicMediaType canonical mapping', () => {
    it("maps 'tv' → 'series'", () => {
        expect(toPublicMediaType('tv')).toBe('series');
    });

    it("maps 'TV' (uppercase) → 'series'", () => {
        expect(toPublicMediaType('TV')).toBe('series');
    });

    it("maps 'show' → 'series'", () => {
        expect(toPublicMediaType('show')).toBe('series');
    });

    it("maps 'movie' → 'movie' (unchanged)", () => {
        expect(toPublicMediaType('movie')).toBe('movie');
    });

    it("maps 'episode' → 'episode' (unchanged)", () => {
        expect(toPublicMediaType('episode')).toBe('episode');
    });

    it("maps 'season' → 'season' (unchanged)", () => {
        expect(toPublicMediaType('season')).toBe('season');
    });
});
