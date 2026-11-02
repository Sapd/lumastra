// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, queries } = vi.hoisted(() => ({
    mockConfig: { LIVETV_HIDE_OFFLINE_AFTER_FAILURES: 0 },
    queries: {
        listOfflineStationIds: vi.fn(),
        recordFailure: vi.fn(),
        recordSuccess: vi.fn(),
        listForChannels: vi.fn(),
    },
}));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/livetv-channel-health.queries.js', async () => ({
    ...(await vi.importActual<object>(
        '$lib/server/database/queries/livetv-channel-health.queries.js',
    )),
    ...queries,
}));

import {
    applyFailureEventToHealth,
    healthState,
    hideOfflineStations,
    invalidateHiddenStationsCache,
    recordStartFailure,
    recordStartSuccess,
    toHealthView,
    withHealth,
} from './channel-health.service.js';

const feedA = '00000000-0000-4000-8000-00000000000a';
const feedB = '00000000-0000-4000-8000-00000000000b';
const sql = {} as never;

beforeEach(() => {
    vi.resetAllMocks();
    invalidateHiddenStationsCache();
    mockConfig.LIVETV_HIDE_OFFLINE_AFTER_FAILURES = 0;
});

describe('healthState', () => {
    it.each([
        [undefined, 'ok'],
        [0, 'ok'],
        [1, 'failing'],
        [2, 'failing'],
        [3, 'offline'],
        [40, 'offline'],
    ] as const)('%s consecutive failures is %s', (failures, state) => {
        expect(
            healthState(failures === undefined ? undefined : { consecutive_failures: failures }),
        ).toBe(state);
    });
});

describe('toHealthView', () => {
    it('renders ISO times and omits what is unknown', () => {
        expect(
            toHealthView({
                channel_id: feedA,
                consecutive_failures: 3,
                last_reason: 'channel_offline',
                last_failure_at: new Date('2026-10-20T10:00:00Z'),
                last_success_at: null,
                updated_at: new Date(),
            }),
        ).toEqual({
            state: 'offline',
            consecutiveFailures: 3,
            lastReason: 'channel_offline',
            lastFailureAt: '2026-10-20T10:00:00.000Z',
        });
        expect(toHealthView(undefined)).toEqual({ state: 'ok', consecutiveFailures: 0 });
    });
});

describe('applyFailureEventToHealth', () => {
    it('counts the feed id before the channel id', async () => {
        await applyFailureEventToHealth(sql, {
            channelId: feedA,
            feedId: feedB,
            reason: 'provider_auth_failed',
            occurredAt: '2026-10-20T10:00:00Z',
        });
        expect(queries.recordFailure).toHaveBeenCalledWith(
            sql,
            feedB,
            'provider_auth_failed',
            new Date('2026-10-20T10:00:00Z'),
        );
    });

    it('does not count an exhausted summary on top of the per-feed events', async () => {
        await applyFailureEventToHealth(sql, {
            channelId: feedA,
            reason: 'all_feeds_failed',
            outcome: 'exhausted',
            occurredAt: new Date(),
        });
        expect(queries.recordFailure).not.toHaveBeenCalled();
    });

    it('ignores events without a typed reason or a UUID target', async () => {
        await applyFailureEventToHealth(sql, { channelId: feedA, occurredAt: 'x' });
        await applyFailureEventToHealth(sql, {
            channelId: 'not-a-uuid',
            reason: 'channel_offline',
            occurredAt: 'x',
        });
        expect(queries.recordFailure).not.toHaveBeenCalled();
    });

    it.each([
        ['egress', 'encoder_failed'],
        ['egress', 'upstream_stalled'],
        ['adaptive-egress', 'no_video'],
    ] as const)(
        'does not count a %s event (our own encoder) with reason %s',
        async (source, reason) => {
            await applyFailureEventToHealth(sql, {
                channelId: feedA,
                source,
                reason,
                occurredAt: new Date(),
            });
            expect(queries.recordFailure).not.toHaveBeenCalled();
        },
    );

    it.each(['encoder_failed', 'provider_connection_limit'] as const)(
        'does not count %s against the feed',
        async (reason) => {
            await applyFailureEventToHealth(sql, {
                channelId: feedA,
                source: 'ingest',
                reason,
                occurredAt: new Date(),
            });
            expect(queries.recordFailure).not.toHaveBeenCalled();
        },
    );

    it('does not bill a backup URL (index above 0, no feedId) to the primary channel', async () => {
        await applyFailureEventToHealth(sql, {
            channelId: feedA,
            source: 'ingest',
            streamUrlIndex: 1,
            reason: 'provider_auth_failed',
            occurredAt: new Date(),
        });
        expect(queries.recordFailure).not.toHaveBeenCalled();
    });

    it('counts an ingest failure of the primary URL, and of a backup that names its feed', async () => {
        await applyFailureEventToHealth(sql, {
            channelId: feedA,
            source: 'ingest',
            streamUrlIndex: 0,
            reason: 'provider_auth_failed',
            occurredAt: new Date(),
        });
        await applyFailureEventToHealth(sql, {
            channelId: feedA,
            feedId: feedB,
            source: 'ingest',
            streamUrlIndex: 1,
            reason: 'provider_auth_failed',
            occurredAt: new Date(),
        });
        expect(queries.recordFailure.mock.calls.map((c) => c[1])).toEqual([feedA, feedB]);
    });

    it('never throws', async () => {
        queries.recordFailure.mockRejectedValue(new Error('db down'));
        await expect(
            applyFailureEventToHealth(sql, {
                channelId: feedA,
                reason: 'channel_offline',
                occurredAt: new Date(),
            }),
        ).resolves.toBeUndefined();
    });
});

describe('recordStartFailure', () => {
    it('records each failed feed with its own reason', async () => {
        await recordStartFailure(sql, feedA, {
            reason: 'provider_unreachable',
            feeds: [
                { feedId: feedA, reason: 'provider_unreachable' },
                { feedId: feedB, reason: 'provider_unreachable' },
            ],
        });
        expect(queries.recordFailure).toHaveBeenCalledTimes(2);
        expect(queries.recordFailure.mock.calls.map((c) => c[1])).toEqual([feedA, feedB]);
    });
    it('records the channel when no feed list is given', async () => {
        await recordStartFailure(sql, feedA, { reason: 'provider_unreachable' });
        expect(queries.recordFailure).toHaveBeenCalledWith(
            sql,
            feedA,
            'provider_unreachable',
            expect.any(Date),
        );
    });
});

describe('withHealth', () => {
    it('adds health to every item and defaults to ok', async () => {
        queries.listForChannels.mockResolvedValue([
            {
                channel_id: feedA,
                consecutive_failures: 4,
                last_reason: 'channel_offline',
                last_failure_at: new Date('2026-10-20T10:00:00Z'),
                last_success_at: null,
                updated_at: new Date(),
            },
        ]);
        const out = await withHealth(sql, [{ id: feedA }, { id: feedB }]);
        expect(out[0].health.state).toBe('offline');
        expect(out[1].health).toEqual({ state: 'ok', consecutiveFailures: 0 });
    });
    it('shows ok when the read fails', async () => {
        queries.listForChannels.mockRejectedValue(new Error('db'));
        const out = await withHealth(sql, [{ id: feedA }]);
        expect(out[0].health.state).toBe('ok');
    });
});

describe('recordStartSuccess', () => {
    it('ends the failure streak and never throws', async () => {
        await recordStartSuccess(sql, feedA);
        expect(queries.recordSuccess).toHaveBeenCalledWith(sql, feedA);
        queries.recordSuccess.mockRejectedValue(new Error('db'));
        await expect(recordStartSuccess(sql, feedA)).resolves.toBeUndefined();
    });
});

describe('hideOfflineStations', () => {
    const lineup = [
        { id: feedA, backupGroupId: undefined },
        { id: feedB, backupGroupId: 'group-1' },
    ];
    it('is off at 0', async () => {
        expect(await hideOfflineStations(lineup, {})).toBe(lineup);
        expect(queries.listOfflineStationIds).not.toHaveBeenCalled();
    });
    it('hides a station by its backup group id or its feed id', async () => {
        mockConfig.LIVETV_HIDE_OFFLINE_AFTER_FAILURES = 3;
        queries.listOfflineStationIds.mockResolvedValue(['group-1']);
        expect(await hideOfflineStations(lineup, {})).toEqual([lineup[0]]);
        // The lineup is filtered in JS: the query takes no station ids.
        expect(queries.listOfflineStationIds).toHaveBeenCalledWith(expect.anything(), 3, 6);
    });
    it('reads the hidden set once per ~30 s and not per request', async () => {
        mockConfig.LIVETV_HIDE_OFFLINE_AFTER_FAILURES = 3;
        queries.listOfflineStationIds.mockResolvedValue(['group-1']);
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
            await hideOfflineStations(lineup, {});
            await hideOfflineStations(lineup, {});
            expect(queries.listOfflineStationIds).toHaveBeenCalledTimes(1);
            vi.setSystemTime(new Date('2026-10-20T10:00:31Z'));
            await hideOfflineStations(lineup, {});
            expect(queries.listOfflineStationIds).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
    it('drops the cached set on invalidation and after a health write', async () => {
        mockConfig.LIVETV_HIDE_OFFLINE_AFTER_FAILURES = 3;
        queries.listOfflineStationIds.mockResolvedValue(['group-1']);
        await hideOfflineStations(lineup, {});
        invalidateHiddenStationsCache();
        await hideOfflineStations(lineup, {});
        expect(queries.listOfflineStationIds).toHaveBeenCalledTimes(2);

        await recordStartSuccess(sql, feedA);
        await hideOfflineStations(lineup, {});
        expect(queries.listOfflineStationIds).toHaveBeenCalledTimes(3);

        await applyFailureEventToHealth(sql, {
            channelId: feedA,
            source: 'ingest',
            reason: 'channel_offline',
            occurredAt: new Date(),
        });
        await hideOfflineStations(lineup, {});
        expect(queries.listOfflineStationIds).toHaveBeenCalledTimes(4);
    });
    it('never hides anything from an administrator', async () => {
        mockConfig.LIVETV_HIDE_OFFLINE_AFTER_FAILURES = 3;
        expect(await hideOfflineStations(lineup, { principal: { isAdmin: true } })).toBe(lineup);
        expect(queries.listOfflineStationIds).not.toHaveBeenCalled();
    });
    it('shows the full lineup when the health read fails', async () => {
        mockConfig.LIVETV_HIDE_OFFLINE_AFTER_FAILURES = 3;
        queries.listOfflineStationIds.mockRejectedValue(new Error('db'));
        expect(await hideOfflineStations(lineup, {})).toBe(lineup);
    });
});
