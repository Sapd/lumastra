// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * trickplay-params-sync coverage-table tests.
 *
 * Verifies behaviourally that:
 * A) A successful file reconciles the item-level row only after its params land.
 * B) A no-provider marker reconciles the item-level row after its write lands.
 * C) The fetchSlice gate routes to `findCoverageTableBacklog` when
 *    `useCoverageTable` is true and drainMode is not 'force', and routes to
 *    `getItemsWithoutTrickplayParams` otherwise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as TrickplayParamsQueries from '$lib/server/database/queries/trickplay-params.queries.js';
import type * as ServerConfig from '$lib/server/config.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any real imports.
// ---------------------------------------------------------------------------

const trickplayQueries = vi.hoisted(() => ({
    getItemsWithoutTrickplayParams: vi
        .fn<typeof TrickplayParamsQueries.getItemsWithoutTrickplayParams>()
        .mockResolvedValue([]),
    getTrickplayBacklogCounts: vi.fn().mockResolvedValue({
        remaining: 0,
        analyzed: 0,
        ineligible: 0,
        failed: 0,
    }),
    markTrickplayItemTried: vi.fn().mockResolvedValue(true),
    findCoverageTableBacklog: vi
        .fn<typeof TrickplayParamsQueries.findCoverageTableBacklog>()
        .mockResolvedValue([]),
    reconcileTrickplayCoverageRows: vi.fn().mockResolvedValue(0),
    TRICKPLAY_PARAMS_PROCESSING_VERSION: 3,
}));
vi.mock('$lib/server/database/queries/trickplay-params.queries.js', () => trickplayQueries);

const trickplayServiceMock = vi.hoisted(() => ({
    getParams: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
}));
vi.mock('../../../../services/trickplay-params.service.js', () => ({
    trickplayParamsService: trickplayServiceMock,
}));

vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

// Config mock: controllable `getAuthoritativeStageIds` Set and `DISABLE_TRICKPLAY_PARAMS`.
// Use importOriginal so the registry and other consumers of config.js still get
// the real exports; only override the two surfaces the task reads.
const configMock = vi.hoisted(() => ({
    authoritativeStageIds: new Set<string>(),
    disableTrickplayParams: false,
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ServerConfig>();
    return {
        ...actual,
        config: new Proxy(actual.config as object, {
            get(target: object, prop: string) {
                if (prop === 'DISABLE_TRICKPLAY_PARAMS') return configMock.disableTrickplayParams;
                return (target as Record<string, unknown>)[prop];
            },
        }),
        getAuthoritativeStageIds: () => configMock.authoritativeStageIds,
    };
});

// drain-backlog mock: calls fetchSlice once, then processSlice with the
// items returned. resolveDrainMode is also controllable.
const drainModeMock = vi.hoisted(() => ({ value: 'catchup' as string }));

vi.mock('../../../../plugins/runtime/drain-backlog.js', () => ({
    drainBacklog: vi.fn(
        async (
            _ctx: unknown,
            opts: {
                fetchSlice: (
                    limit: number,
                ) => Promise<{ items: unknown[]; remainingHint?: number }>;
                processSlice: (items: unknown[], signal: AbortSignal) => Promise<unknown>;
            },
        ) => {
            const { items } = await opts.fetchSlice(200);
            if (items.length > 0) {
                await opts.processSlice(items, new AbortController().signal);
            }
            return { stopReason: 'drained' };
        },
    ),
    drainWipe: vi.fn().mockResolvedValue(undefined),
    resolveDrainMode: vi.fn((_mode: unknown) => drainModeMock.value),
    formatStopReason: vi.fn().mockReturnValue(''),
    computeRemainingHint: vi.fn().mockReturnValue(0),
    isAbortedStop: vi.fn().mockReturnValue(false),
    lazyBacklog: vi.fn((fn: () => unknown) => {
        const memo = { value: undefined as unknown, called: false };
        const getter = async () => {
            if (!memo.called) {
                memo.value = await fn();
                memo.called = true;
            }
            return memo.value;
        };
        (getter as unknown as { peek: () => unknown }).peek = () => memo.value;
        return getter;
    }),
}));

// ---------------------------------------------------------------------------
// Import the REAL task after all mocks are in place.
// ---------------------------------------------------------------------------

import { trickplayParamsSyncTask } from '../trickplay-params-sync.js';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecuteCtx = Parameters<typeof trickplayParamsSyncTask.execute>[0];

function makeCtx(input: Record<string, unknown> = {}): ExecuteCtx {
    const ac = new AbortController();
    const { sql } = makeRecordingSql({ rows: [{ count: 0 }] });
    return {
        sql,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-trickplay',
        input,
        reportProgress: vi.fn(),
    } as unknown as ExecuteCtx;
}

function makeItem(
    id: string = 'aaaaaaaa-0000-0000-0000-000000000001',
    fileId: string = 'bbbbbbbb-0000-0000-0000-000000000001',
): { id: string; fileId: string; jellyfinId: string | null } {
    return { id, fileId, jellyfinId: null };
}

// ---------------------------------------------------------------------------
// Behaviour: success path — reconcile only after params land
// ---------------------------------------------------------------------------

describe('trickplay-params-sync: success path reconciles coverage', () => {
    const ITEM_ID = 'cccccccc-1111-0000-0000-000000000001';
    const FILE_ID = 'dddddddd-1111-0000-0000-000000000001';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.authoritativeStageIds = new Set(['trickplay-params-sync']);
        configMock.disableTrickplayParams = false;
        drainModeMock.value = 'catchup';
        // getParams returns non-null → success branch
        trickplayServiceMock.getParams.mockResolvedValue({
            width: 320,
            height: 180,
        });
        trickplayQueries.findCoverageTableBacklog.mockResolvedValue([makeItem(ITEM_ID, FILE_ID)]);
        trickplayQueries.getTrickplayBacklogCounts.mockResolvedValue({
            remaining: 1,
            analyzed: 0,
            ineligible: 0,
            failed: 0,
        });
    });

    it('reconciles the processed item against all linked files', async () => {
        await trickplayParamsSyncTask.execute(makeCtx());
        expect(trickplayQueries.reconcileTrickplayCoverageRows).toHaveBeenCalledWith(
            expect.anything(),
            3,
            1,
            ITEM_ID,
        );
    });
});

// ---------------------------------------------------------------------------
// Behaviour: no-result (null) path — reconcile after marker
// ---------------------------------------------------------------------------

describe('trickplay-params-sync: no-result path reconciles coverage', () => {
    const ITEM_ID = 'eeeeeeee-2222-0000-0000-000000000001';
    const FILE_ID = 'ffffffff-2222-0000-0000-000000000001';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.authoritativeStageIds = new Set(['trickplay-params-sync']);
        configMock.disableTrickplayParams = false;
        drainModeMock.value = 'catchup';
        // getParams returns null → skip branch
        trickplayServiceMock.getParams.mockResolvedValue(null);
        trickplayQueries.markTrickplayItemTried.mockResolvedValue(true);
        trickplayQueries.findCoverageTableBacklog.mockResolvedValue([makeItem(ITEM_ID, FILE_ID)]);
        trickplayQueries.getTrickplayBacklogCounts.mockResolvedValue({
            remaining: 1,
            analyzed: 0,
            ineligible: 0,
            failed: 0,
        });
    });

    it('reconciles the processed item after the no-provider marker lands', async () => {
        await trickplayParamsSyncTask.execute(makeCtx());
        expect(trickplayQueries.reconcileTrickplayCoverageRows).toHaveBeenCalledWith(
            expect.anything(),
            3,
            1,
            ITEM_ID,
        );
    });
});

// ---------------------------------------------------------------------------
// Behaviour: gate routing — findCoverageTableBacklog vs getItemsWithoutTrickplayParams
// ---------------------------------------------------------------------------

describe('trickplay-params-sync: gate routes fetchSlice correctly', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.disableTrickplayParams = false;
        // getParams returns null by default; we only care about which fetch ran
        trickplayServiceMock.getParams.mockResolvedValue(null);
        trickplayQueries.markTrickplayItemTried.mockResolvedValue(true);
        trickplayQueries.getTrickplayBacklogCounts.mockResolvedValue({
            remaining: 0,
            analyzed: 0,
            ineligible: 0,
            failed: 0,
        });
        trickplayQueries.findCoverageTableBacklog.mockResolvedValue([]);
        trickplayQueries.getItemsWithoutTrickplayParams.mockResolvedValue([]);
    });

    it('uses findCoverageTableBacklog when trickplay-params-sync is in authoritative stages and drainMode is catchup', async () => {
        configMock.authoritativeStageIds = new Set(['trickplay-params-sync']);
        drainModeMock.value = 'catchup';

        await trickplayParamsSyncTask.execute(makeCtx({ mode: 'catchup' }));

        expect(trickplayQueries.findCoverageTableBacklog).toHaveBeenCalledWith(
            expect.anything(),
            'trickplay-params-sync',
            expect.any(Number),
            3,
        );
        expect(trickplayQueries.getItemsWithoutTrickplayParams).not.toHaveBeenCalled();
    });

    it('uses getItemsWithoutTrickplayParams when trickplay-params-sync is NOT in authoritative stages', async () => {
        configMock.authoritativeStageIds = new Set<string>();
        drainModeMock.value = 'catchup';

        await trickplayParamsSyncTask.execute(makeCtx({ mode: 'catchup' }));

        expect(trickplayQueries.getItemsWithoutTrickplayParams).toHaveBeenCalled();
        expect(trickplayQueries.findCoverageTableBacklog).not.toHaveBeenCalled();
    });

    it('uses getItemsWithoutTrickplayParams even when in authoritative stages if drainMode is force', async () => {
        configMock.authoritativeStageIds = new Set(['trickplay-params-sync']);
        drainModeMock.value = 'force';

        await trickplayParamsSyncTask.execute(makeCtx({ mode: 'force' }));

        expect(trickplayQueries.getItemsWithoutTrickplayParams).toHaveBeenCalled();
        expect(trickplayQueries.findCoverageTableBacklog).not.toHaveBeenCalled();
    });
});
