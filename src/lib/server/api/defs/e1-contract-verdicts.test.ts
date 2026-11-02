// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E1 verdict regression guard — gate ↔ doc convergence for the rows executed in
 * the E1 decision table (rows #1, #2, #23, #24, #40) plus the two ratified
 * structural changes (public DELETE /watch-together/{code} removal; probe-status
 * `[id]`/`[itemId]` shared-param resolution).
 *
 * These are pure schema-shape assertions: each def's declared mount() gate
 * (`def.request.*`) and published OpenAPI request schema (`def.docs.*`) are
 * safeParsed against representative inputs. No handler I/O runs — external
 * modules are mocked only so the def modules import cleanly.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

// ── Module mocks (hoisted; keep the def import graphs side-effect free) ───────

vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    config: {},
    features: {},
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/database/index.js', () => ({ getDb: vi.fn().mockReturnValue({}) }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn().mockReturnValue({}) }));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ set: vi.fn(), delete: vi.fn() }) },
    CACHE_NAMESPACES: { musicNextTrack: 'musicNextTrack' },
}));

vi.mock('$lib/server/services/access-control.service.js', () => ({
    createAccessGroup: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
}));

vi.mock('$lib/server/services/watch-together.service.js', () => ({
    getSession: vi.fn(),
    getSessionWithParticipant: vi.fn(),
    endSession: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const UUID = '550e8400-e29b-41d4-a716-446655440000';

/** Extract a Zod schema declared on a docs method's `body`/`query` slot. */
function docSchema(method: unknown, slot: 'body' | 'query'): z.ZodType {
    const s = (method as Record<string, unknown>)[slot];
    if (!s || typeof (s as z.ZodType).safeParse !== 'function') {
        throw new Error(`Expected a Zod schema at docs.${slot}`);
    }
    return s as z.ZodType;
}

// ── #1 POST /access/groups — LOOSEN: doc displayName optional ─────────────────

describe('#1 POST /access/groups — displayName optional in the request doc', async () => {
    const { def } = await import('./access/groups/index.js');
    const docBody = docSchema(def.docs!.POST, 'body');

    it('doc accepts a body WITHOUT displayName (handler defaults it to name)', () => {
        expect(docBody.safeParse({ name: 'editors' }).success).toBe(true);
    });

    it('doc still accepts an explicit displayName', () => {
        expect(docBody.safeParse({ name: 'editors', displayName: 'Editors' }).success).toBe(true);
    });

    it('gate (request.body) also treats displayName as optional', () => {
        expect(def.request!.body!.safeParse({ name: 'editors' }).success).toBe(true);
    });
});

// ── #2 membership addresses a UUID userId without a mutation body ───────────

describe('#2 PUT /access/groups/{id}/members/{userId}', async () => {
    const { def } = await import('./access/groups/[id]/members/[userId].js');
    const { def: collection } = await import('./access/groups/[id]/members.js');
    it('gate requires a UUID userId in the member URI', () => {
        expect(def.request!.params!.safeParse({ id: UUID, userId: UUID }).success).toBe(true);
        expect(def.request!.params!.safeParse({ id: UUID, userId: 'bob' }).success).toBe(false);
    });
    it('gate rejects the fictional username parameter', () => {
        expect(def.request!.params!.safeParse({ id: UUID, username: 'bob' }).success).toBe(false);
    });
    it('PUT and DELETE declare no request body', () => {
        expect(Reflect.get(def.request!, 'body')).toBeUndefined();
        expect(def.docs!.PUT!.body).toBeUndefined();
        expect(def.docs!.DELETE!.body).toBeUndefined();
    });
    it('does not retain collection mutation methods', () => {
        expect(Reflect.get(collection.handlers, 'POST')).toBeUndefined();
        expect(Reflect.get(collection.handlers, 'DELETE')).toBeUndefined();
    });
});

// ── #23 POST /music/recommendations — gate requires uuid track ids ───────────

describe('#23 POST /music/recommendations — gate requires uuid track ids', async () => {
    const { def } = await import('./music/recommendations.js');
    const gate = def.request!.body!;

    it('gate accepts a UUID currentTrackId', () => {
        expect(gate.safeParse({ context: { currentTrackId: UUID } }).success).toBe(true);
    });

    it('gate rejects a non-UUID currentTrackId (early 422 instead of post-lookup 404)', () => {
        expect(gate.safeParse({ context: { currentTrackId: 'not-a-uuid' } }).success).toBe(false);
    });

    it('gate rejects a non-UUID entry in a context list', () => {
        expect(gate.safeParse({ context: { history: ['not-a-uuid'] } }).success).toBe(false);
    });

    it('doc body is the same schema as the gate', () => {
        const docBody = docSchema(def.docs!.POST, 'body');
        expect(docBody.safeParse({ context: { currentTrackId: 'not-a-uuid' } }).success).toBe(
            false,
        );
    });
});

// ── #24 POST /play-sessions/{id}/beacon — FIX-BOTH: doc := gate reality ──────

describe('#24 POST /play-sessions/{id}/beacon — doc converges on gate reality', async () => {
    const { def } = await import('./play-sessions/[id]/beacon.js');
    const docBody = docSchema(def.docs!.POST, 'body');

    it('doc requires the unified position, status, sequence and elapsed fields', () => {
        expect(
            docBody.safeParse({
                positionMs: 0,
                status: 'ACTIVE',
                eventSeq: 1,
                sessionElapsedMs: 0,
            }).success,
        ).toBe(true);
        expect(
            docBody.safeParse({
                positionMs: 1200,
                status: 'COMPLETED',
                eventSeq: 2,
                sessionElapsedMs: 1200,
                nextMediaId: UUID,
            }).success,
        ).toBe(true);
    });

    it('doc rejects the fictional playing-only body (status/positionMs missing)', () => {
        expect(docBody.safeParse({ playing: true }).success).toBe(false);
    });

    it('doc rejects an unknown status enum value', () => {
        expect(docBody.safeParse({ positionMs: 0, status: 'PLAYING' }).success).toBe(false);
    });

    it('doc is the same schema as the gate', () => {
        expect(docBody).toBe(def.request!.body!);
    });
});

// ── #40 PATCH /setup/onboarding — FIX-BOTH: {'all'} ∪ VALID_STEPS ─────────────

describe("#40 PATCH /setup/onboarding — gate+doc converge on {'all'} ∪ VALID_STEPS", async () => {
    const { def } = await import('./setup/onboarding.js');
    const gate = def.request!.body!;
    const docBody = docSchema(def.docs!.PATCH, 'body');
    const validSteps = [
        'library_paths',
        'tmdb_config',
        'library_scan',
        'ai_config',
        'onboarding_dismissed',
    ];

    it("gate accepts 'all' and every valid step key", () => {
        expect(gate.safeParse({ dismiss: 'all' }).success).toBe(true);
        for (const step of validSteps) {
            expect(gate.safeParse({ dismiss: step }).success).toBe(true);
        }
    });

    it('gate rejects an unknown dismiss target', () => {
        expect(gate.safeParse({ dismiss: 'not_a_step' }).success).toBe(false);
        expect(gate.safeParse({ dismiss: '' }).success).toBe(false);
    });

    it('doc mirrors the gate grammar exactly', () => {
        expect(docBody).toBe(gate);
        expect(docBody.safeParse({ dismiss: 'ai_config' }).success).toBe(true);
        expect(docBody.safeParse({ dismiss: 'bogus' }).success).toBe(false);
    });
});

// ── Structural: probe-status resolves under BOTH `itemId` and `id` params ─────

describe('probe-status — shared def resolves under itemId (internal) and id (v1)', async () => {
    const { def } = await import('./playback/probe-status.js');
    const params = def.request!.params!;

    it('accepts the internal route param (itemId)', () => {
        expect(params.safeParse({ itemId: 'abc' }).success).toBe(true);
    });

    it('accepts the v1 shared-param route param (id) — fixes dead-on-arrival', () => {
        expect(params.safeParse({ id: 'abc' }).success).toBe(true);
    });
});

// ── Structural: DELETE /watch-together/{code} not exposed on the public v1 route

describe('watch-together v1 route — GET only, DELETE not public', async () => {
    const route = await import('../../../../routes/api/v1/watch-together/[code]/+server.js');

    it('exposes GET on the public v1 surface', () => {
        expect(typeof route.GET).toBe('function');
    });

    it('does NOT expose DELETE on the public v1 surface', () => {
        expect((route as Record<string, unknown>).DELETE).toBeUndefined();
    });
});
