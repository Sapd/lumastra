// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/admin/fix/seek-previews` inputs. Trickplay is a per-item task with no
 * schedule, so scheduler_state.last_fired_at is null forever; the last run
 * comes from stage completions. Generation being off is reported, and a failed
 * read is "unknown", never "not paused" / "never ran".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    lastCompleted: null as Date | null,
    lastFails: false,
    schedule: null as { paused: boolean; lastFiredAt: Date | null } | null,
    scheduleFails: false,
    enabled: true,
    provider: 'prefer_local',
}));

const sqlStub = Object.assign(() => {
    if (state.lastFails) return Promise.reject(new Error('boom'));
    return Promise.resolve([{ at: state.lastCompleted }]);
}, {});

vi.mock('$lib/server/database/connection.js', () => ({ getAdminDb: () => sqlStub }));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get TRICKPLAY_ENABLED() {
            return state.enabled;
        },
        get TRICKPLAY_PROVIDER() {
            return state.provider;
        },
    },
}));
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    getStageCoverage: async () => ({
        eligibleItems: 10,
        withRow: 10,
        completed: 4,
        pending: 6,
        running: 0,
        failedTransient: 0,
        failedPermanent: 0,
        skipped: 0,
        obsolete: 0,
    }),
}));
vi.mock('$lib/server/tasks/scheduler-state.js', () => ({
    getSchedulerState: async () => {
        if (state.scheduleFails) throw new Error('boom');
        return state.schedule;
    },
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getAllTasks: () => [{ id: 'trickplay-generation' }] },
}));

import { def } from './trickplay-check.js';
import {
    TrickplayCheckSchema,
    type TrickplayCheck,
} from '$lib/components/admin/fix/trickplay-check.schema.js';

async function check(): Promise<TrickplayCheck> {
    const resp = await def.handlers.GET!({} as never, {} as never);
    return TrickplayCheckSchema.parse(await (resp as Response).json());
}

beforeEach(() => {
    state.lastCompleted = null;
    state.lastFails = false;
    state.schedule = null;
    state.scheduleFails = false;
    state.enabled = true;
    state.provider = 'prefer_local';
});

describe('trickplay-check inputs', () => {
    it('last run comes from stage completions, not the absent scheduler row', async () => {
        state.lastCompleted = new Date('2026-10-05T12:00:00.000Z');
        const body = await check();
        expect(body.taskLastFiredAt).toBe('2026-10-05T12:00:00.000Z');
        expect(body.taskPaused).toBe(false);
    });

    it('a failed last-completion read is unknown, not "never ran"', async () => {
        state.lastFails = true;
        const body = await check();
        expect(body.taskLastFiredAt).toBeNull();
        expect(body.taskLastFiredUnreadable).toBe(true);
    });

    it('a failed scheduler read is an unknown pause state', async () => {
        state.scheduleFails = true;
        expect((await check()).taskPaused).toBeNull();
        state.scheduleFails = false;
        state.schedule = { paused: true, lastFiredAt: null };
        expect((await check()).taskPaused).toBe(true);
    });

    it('reports generation being off and the provider', async () => {
        state.enabled = false;
        state.provider = 'jellyfin_disk';
        const body = await check();
        expect(body.generationEnabled).toBe(false);
        expect(body.provider).toBe('jellyfin_disk');
    });
});
