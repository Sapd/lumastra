// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { getTrickplayAvailability } from './trickplay-params.queries.js';

const STAGE_ID = 'trickplay-generation';
const MIN_VERSION = 1;

/**
 * `getTrickplayAvailability` issues two queries in parallel (stage-state row,
 * then `trickplay_params` widths). This mock returns `stageRows` on the
 * first call and `widthRows` on the second, regardless of call order set up
 * by `Promise.all` (postgres.js template calls are synchronous dispatch, so
 * order is stable in practice, but we key off call count defensively).
 */
function mockSqlWith(stageRows: unknown[], widthRows: unknown[]) {
    const calls: unknown[][] = [stageRows, widthRows];
    let i = 0;
    return vi.fn().mockImplementation(() => Promise.resolve(calls[i++] ?? []));
}

describe('getTrickplayAvailability', () => {
    it.each([
        [null, false],
        [{ status: 'running', processing_version: 1, invalidated_at: null }, false],
        [{ status: 'pending', processing_version: 1, invalidated_at: null }, false],
        [{ status: 'completed', processing_version: 0, invalidated_at: null }, false],
        [{ status: 'completed', processing_version: 1, invalidated_at: new Date() }, false],
        [{ status: 'completed', processing_version: 1, invalidated_at: null }, true],
    ])(
        'only authorizes artifact repair for a current completed stage: %j',
        async (stage, expected) => {
            const result = await getTrickplayAvailability(
                mockSqlWith(stage ? [stage] : [], []) as never,
                'item-1',
                STAGE_ID,
                MIN_VERSION,
                'file-b',
            );
            expect(Boolean((result as typeof result & { needsRepair?: boolean }).needsRepair)).toBe(
                expected,
            );
        },
    );

    it('restricts available widths to the selected physical file', async () => {
        const sql = mockSqlWith(
            [{ status: 'completed', processing_version: 1, invalidated_at: null }],
            [],
        );
        expect(
            await getTrickplayAvailability(sql as never, 'item-1', STAGE_ID, MIN_VERSION, 'file-b'),
        ).toEqual({ state: 'pending', widths: [], needsRepair: true });
        const [parts, ...values] = sql.mock.calls[1]!;
        expect((parts as TemplateStringsArray).join('?')).toContain('file_id =');
        expect(values).toContain('file-b');
    });

    it('reports ready with widths when the stage is completed, current, and params exist', async () => {
        const mockSql = mockSqlWith(
            [{ status: 'completed', processing_version: 1, invalidated_at: null }],
            [{ width: 320 }],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'ready', widths: [320] });
    });

    it('reports every distinct width when multiple resolutions exist', async () => {
        const mockSql = mockSqlWith(
            [{ status: 'completed', processing_version: 1, invalidated_at: null }],
            [{ width: 160 }, { width: 320 }, { width: 640 }],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'ready', widths: [160, 320, 640] });
    });

    it('reports pending when there is no stage-state row at all (never processed)', async () => {
        const mockSql = mockSqlWith([], []);

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'pending', widths: [] });
    });

    it('reports pending — not ready — when the stage says completed but no params rows exist', async () => {
        // The disagreement case: stage-state coverage was written but the
        // trickplay_params rows are missing (or not yet committed). Prefer
        // under-promising `pending` over advertising tiles that 404.
        const mockSql = mockSqlWith(
            [{ status: 'completed', processing_version: 1, invalidated_at: null }],
            [],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'pending', widths: [], needsRepair: true });
    });

    it('reports pending, not unsupported, when skipped_permanent carries the eligibility-dispose reason', async () => {
        // The only writer of skipped_permanent for trickplay-generation is the
        // sweep's eligibility-dispose pass (stage-disposition-runner.ts), which
        // always stamps skipped_reason 'ineligible' — a recoverable "not probed
        // yet" tombstone, not a genuine dead end. Reporting 'unsupported' here
        // would tell a caching client to never retry an item that is about to
        // heal itself the instant media-probe writes its video stream.
        const mockSql = mockSqlWith(
            [
                {
                    status: 'skipped_permanent',
                    processing_version: 1,
                    invalidated_at: null,
                    skipped_reason: 'ineligible',
                },
            ],
            [],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'pending', widths: [] });
    });

    it('reports pending, not unsupported, when skipped_permanent carries the legacy no-file-linked reason', async () => {
        const mockSql = mockSqlWith(
            [
                {
                    status: 'skipped_permanent',
                    processing_version: 1,
                    invalidated_at: null,
                    skipped_reason: 'no-file-linked',
                },
            ],
            [],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'pending', widths: [] });
    });

    it('reports pending, not unsupported, when trickplay is switched off install-wide', async () => {
        // TRICKPLAY_ENABLED defaults to FALSE, so on a stock install the stage's
        // `trickplay-generation-disabled` predicate tombstones every video under
        // this reason. 'unsupported' is a strong client promise ("never retry"),
        // and answering it here would tell every client that no title will ever
        // have scrub thumbnails — for a switch the operator can flip in the
        // admin UI, after which the sweep's eligibility heal re-enrols the whole
        // library within a tick.
        const mockSql = mockSqlWith(
            [
                {
                    status: 'skipped_permanent',
                    processing_version: 1,
                    invalidated_at: null,
                    skipped_reason: 'trickplay-disabled',
                },
            ],
            [],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'pending', widths: [] });
    });

    it('reports unsupported when skipped_permanent carries a reason outside the recoverable set', async () => {
        const mockSql = mockSqlWith(
            [
                {
                    status: 'skipped_permanent',
                    processing_version: 1,
                    invalidated_at: null,
                    skipped_reason: 'some-genuinely-terminal-reason',
                },
            ],
            [],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'unsupported', widths: [] });
    });

    it('reports pending, not unsupported, when a skipped_permanent row is stale (below minVersion)', async () => {
        const mockSql = mockSqlWith(
            [{ status: 'skipped_permanent', processing_version: 0, invalidated_at: null }],
            [],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'pending', widths: [] });
    });

    it('reports pending, not ready, when a completed row is invalidated', async () => {
        const mockSql = mockSqlWith(
            [
                {
                    status: 'completed',
                    processing_version: 1,
                    invalidated_at: new Date('2026-08-01T00:00:00Z'),
                },
            ],
            [{ width: 320 }],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'pending', widths: [] });
    });

    it('reports pending when the stage row is still pending/running/failed (not terminal)', async () => {
        const mockSql = mockSqlWith(
            [{ status: 'running', processing_version: 1, invalidated_at: null }],
            [],
        );

        const result = await getTrickplayAvailability(
            mockSql as never,
            'item-1',
            STAGE_ID,
            MIN_VERSION,
        );

        expect(result).toEqual({ state: 'pending', widths: [] });
    });
});
