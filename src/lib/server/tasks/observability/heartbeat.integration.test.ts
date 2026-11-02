// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the subsystem heartbeat round-trip (Slice 0).
 *
 * Requires CACHE_URL pointing at a Valkey instance — skipped automatically when
 * absent so `npx vitest run` still works in unit-only mode.
 *
 * Covers:
 *   - writeHeartbeat → readHeartbeats: a freshly-written subsystem is `alive`
 *     with its detail intact.
 *   - an absent key reads back as `alive: false` (dead / never-written).
 *   - a short-TTL key that has expired reads back as dead.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    getCoordinationClient,
    connectValkey,
    disconnectValkey,
} from '$lib/server/cache/valkey.js';
import { writeHeartbeat, readHeartbeats, SUBSYSTEM_REGISTRY } from './heartbeat.js';

const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = Boolean(CACHE_URL);

const ALL_KEYS = SUBSYSTEM_REGISTRY.map((e) => `task:heartbeat:${e.name}`);

describe.runIf(RUN)('subsystem heartbeat round-trip', () => {
    beforeAll(async () => {
        await connectValkey();
    });

    afterAll(async () => {
        const client = getCoordinationClient();
        if (client) await client.customCommand(['DEL', ...ALL_KEYS]);
        await disconnectValkey();
    });

    beforeEach(async () => {
        const client = getCoordinationClient();
        if (client) await client.customCommand(['DEL', ...ALL_KEYS]);
    });

    it('a freshly-written heartbeat reads back alive with its detail', async () => {
        await writeHeartbeat('reconciler', {
            status: 'ok',
            detail: { orphansReclaimed: 3, wedgedStageRowsReclaimed: 1 },
        });

        const views = await readHeartbeats();
        const reconciler = views.find((v) => v.name === 'reconciler');
        expect(reconciler).toBeDefined();
        expect(reconciler?.alive).toBe(true);
        expect(reconciler?.leaderGated).toBe(true);
        expect(reconciler?.detail).toEqual({
            orphansReclaimed: 3,
            wedgedStageRowsReclaimed: 1,
        });
        expect(typeof reconciler?.ageMs).toBe('number');
    });

    it('an absent subsystem key reads back as dead', async () => {
        // Nothing written for stage-sweep → key absent.
        const views = await readHeartbeats();
        const stageSweep = views.find((v) => v.name === 'stage-sweep');
        expect(stageSweep?.alive).toBe(false);
        // Registry metadata is still surfaced for an absent key.
        expect(stageSweep?.leaderGated).toBe(false);
    });

    it('readHeartbeats returns one view per registered subsystem', async () => {
        const views = await readHeartbeats();
        expect(views.map((v) => v.name).sort()).toEqual(
            SUBSYSTEM_REGISTRY.map((e) => e.name).sort(),
        );
    });

    it('a heartbeat whose TTL has expired reads back as dead', async () => {
        // Write a heartbeat directly with a 1s TTL, then let it expire.
        const client = getCoordinationClient();
        expect(client).not.toBeNull();
        const payload = JSON.stringify({
            subsystem: 'pending-write-drain',
            instanceId: 'web-1',
            lastTickAt: Date.now(),
            intervalMs: 5_000,
            leaderGated: true,
            status: 'ok',
            detail: { depth: 0 },
        });
        await client?.customCommand([
            'SET',
            'task:heartbeat:pending-write-drain',
            payload,
            'PX',
            '500',
        ]);
        await new Promise((r) => setTimeout(r, 800));

        const views = await readHeartbeats();
        const drain = views.find((v) => v.name === 'pending-write-drain');
        // Key expired → MGET returns null → dead.
        expect(drain?.alive).toBe(false);
    });
});
