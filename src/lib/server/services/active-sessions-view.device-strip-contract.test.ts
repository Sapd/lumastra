// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Response-contract regression for the device-info redaction in
 * {@link getVisibleActiveSessions}.
 *
 * The live defect: GET /api/sessions logged
 *   RESPONSE CONFORMANCE — items[].clientname: expected string, received undefined
 * because the schema declared `clientname`/`browsername` as REQUIRED while the
 * service deliberately DROPS them for viewers who may not see device info.
 *
 * These tests assert at the seam that actually broke — the service's real
 * output, wrapped in the real `paginate()` envelope, parsed by the real
 * `PagedSessionsResponseSchema` — rather than hand-writing a fixture and
 * parsing that (which would prove nothing about what the service emits).
 */

import { z } from 'zod';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
    features: {
        sessionsPublic: true,
        sessionsDeviceInfoPublic: false,
    },
    FEATURE_PER_TASK_QUEUES: true,
}));

vi.mock('../auth.js', () => ({
    isUserAdmin: () => false,
}));

vi.mock('../cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async (opts: { compute: () => Promise<string> }) => opts.compute(),
}));

vi.mock('./play-session-device.service.js', () => ({
    prefetchAllDeviceSessions: vi.fn().mockResolvedValue({
        byPlaySessionId: new Map(),
        byDeviceUser: new Map(),
    }),
}));

vi.mock('./database.service.js', () => ({
    aiDbService: {
        getSql: vi.fn().mockResolvedValue(null),
    },
}));

const getActiveSessions = vi.fn();
vi.mock('./media-aggregation.service.js', () => ({
    MediaAggregationService: {
        getActiveSessions: (...args: unknown[]) => getActiveSessions(...args),
    },
}));

import { getVisibleActiveSessions } from './active-sessions-view.service.js';
import { paginate } from '../api/problem.js';
import { ActiveSessionSchema } from '$lib/schemas/api-playback-responses';
import type { StreamSession } from '../types.js';

/**
 * A session shaped exactly like what media-aggregation.service.ts emits — every
 * producer there sets clientname/browsername to a non-empty string (it falls
 * back to 'Lumastra'), so the ONLY way they go missing downstream is the strip.
 *
 * Built through the schema's own parse so the fixture cannot silently drift out
 * of contract and quietly weaken every assertion below.
 */
function makeProducedSession(username: string): StreamSession {
    return ActiveSessionSchema.parse({
        __id: `sess-${username}`,
        id: `11111111-1111-4111-8111-11111111111${username.length}`,
        mediaItemId: `11111111-1111-4111-8111-11111111111${username.length}`,
        title: 'A Movie',
        mediaType: 'movie',
        username,
        clientname: 'Lumastra',
        isCarPlay: true,
        browsername: 'Safari',
        formFactor: 'desktop',
        playSessionId: `play-${username}`,
        deviceId: `device-${username}`,
    }) as StreamSession;
}

const PagedSessionsResponseSchema = z.object({
    items: z.array(ActiveSessionSchema),
    page: z.unknown(),
});

/** The exact envelope defs/sessions/index.ts builds around the service output. */
function buildHandlerResponse(sessions: readonly StreamSession[]) {
    const items = [...sessions];
    return paginate(items, { limit: items.length, offset: 0, hasMore: false });
}

describe('GET /api/sessions response contract — redacted device info', () => {
    beforeEach(() => {
        getActiveSessions.mockReset();
        getActiveSessions.mockResolvedValue({
            sessions: [makeProducedSession('alice')],
            cacheTimestamp: 123,
        });
    });

    it('the fixture the producer emits is itself contract-valid (guards the test, not the code)', () => {
        expect(() => makeProducedSession('alice')).not.toThrow();
    });

    it('drops clientname/browsername for a viewer who may not see device info', async () => {
        const result = await getVisibleActiveSessions({
            username: 'alice',
            userGroups: [],
            hasWatchPermission: false,
            hasLiveTvPermission: false,
        });

        expect(result.visible).toBe(true);
        expect(result.sessions).toHaveLength(1);

        const session = result.sessions[0] as Record<string, unknown>;
        // Absent, not empty-string and not 'Unknown' — absence is the signal.
        expect('clientname' in session).toBe(false);
        expect('browsername' in session).toBe(false);
        expect('formFactor' in session).toBe(false);
        expect('isCarPlay' in session).toBe(false);
    });

    it('the redacted response the handler builds PARSES against PagedSessionsResponseSchema', async () => {
        const result = await getVisibleActiveSessions({
            username: 'alice',
            userGroups: [],
            hasWatchPermission: false,
            hasLiveTvPermission: false,
        });

        const body = buildHandlerResponse(result.sessions as StreamSession[]);

        // This is the assertion that was failing in production.
        const parsed = PagedSessionsResponseSchema.safeParse(body);
        if (!parsed.success) {
            throw new Error(
                `response conformance failed: ${JSON.stringify(parsed.error.issues, null, 2)}`,
            );
        }
        expect(parsed.success).toBe(true);
        expect(parsed.data.items[0].clientname).toBeUndefined();
        expect(parsed.data.items[0].browsername).toBeUndefined();
    });

    it('a privileged viewer keeps device info AND still parses', async () => {
        const result = await getVisibleActiveSessions({
            username: 'alice',
            userGroups: [],
            hasWatchPermission: true,
            hasLiveTvPermission: false,
        });

        const body = buildHandlerResponse(result.sessions as StreamSession[]);
        const parsed = PagedSessionsResponseSchema.safeParse(body);
        expect(parsed.success).toBe(true);
        // Cross-check: the strip is conditional, so the same schema must accept
        // the POPULATED shape too. If clientname were ever made required again,
        // only the redacted case above breaks — this one must keep passing.
        expect(parsed.success && parsed.data.items[0].clientname).toBe('Lumastra');
        expect(parsed.success && parsed.data.items[0].isCarPlay).toBe(true);
        expect(parsed.success && parsed.data.items[0].browsername).toBe('Safari');
    });
});
