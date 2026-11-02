// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression coverage for the provider-artwork-backfill `global-guard`: the
 * hourly rate cap and disk-headroom margin now block ENQUEUE (via
 * `stage-sweep`'s pre-drain guard check), not just `execute()`.
 *
 * Prod incident this guards against: the hourly budget (default 2000/hr
 * against a 158k-item backlog) is EXHAUSTED for most of every hour by
 * design, so `execute()` alone catching it was routinely — not rarely —
 * returning `{ success: false }`, which (before the run-wrapper fix) left a
 * stale `'running'` stage row that the orphan reaper reclassified as
 * `failed_transient`, which `stage-sweep` then re-enqueued forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPeekBudget, mockCheckHeadroom, configState } = vi.hoisted(() => ({
    mockPeekBudget: vi.fn(),
    mockCheckHeadroom: vi.fn(),
    configState: {
        PROVIDER_ARTWORK_BACKFILL_ENABLED: true,
        PROVIDER_ARTWORK_MIN_FREE_GB: 5,
        PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR: 2000,
        TMDB_API_KEY: 'test-key',
    },
}));

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('../../../../utils/artwork-rate-budget.js', () => ({
    peekArtworkBudget: mockPeekBudget,
    consumeArtworkBudget: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../../utils/artwork-volume-headroom.js', () => ({
    checkArtworkDiskHeadroom: mockCheckHeadroom,
}));
vi.mock('../../../../config.js', () => ({ config: configState }));

import {
    providerArtworkPosterTask,
    providerArtworkSeasonPosterTask,
} from '../provider-artwork-backfill.js';
import type { StageTerminalDisposition } from '@sapd/lumastra-plugin-sdk';

const guardCtx = {
    sql: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
} as never;

type GlobalGuardDisposition = Extract<StageTerminalDisposition, { kind: 'global-guard' }>;

function isGlobalGuardDisposition(
    d: StageTerminalDisposition | readonly StageTerminalDisposition[] | undefined,
): d is GlobalGuardDisposition {
    return d !== undefined && !Array.isArray(d) && (d as { kind?: string }).kind === 'global-guard';
}

function globalGuardOf(
    disposition: StageTerminalDisposition | readonly StageTerminalDisposition[] | undefined,
): GlobalGuardDisposition {
    if (!isGlobalGuardDisposition(disposition)) {
        throw new Error('expected a single global-guard terminalDisposition');
    }
    return disposition;
}

function laneAGuardDisposition() {
    return globalGuardOf(providerArtworkPosterTask.coversStages?.[0].terminalDisposition);
}

function laneBGuardDisposition() {
    return globalGuardOf(providerArtworkSeasonPosterTask.coversStages?.[0].terminalDisposition);
}

describe('provider-artwork global-guard: hourly budget + disk headroom pre-filter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configState.PROVIDER_ARTWORK_BACKFILL_ENABLED = true;
        configState.PROVIDER_ARTWORK_MIN_FREE_GB = 5;
        configState.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR = 2000;
        configState.TMDB_API_KEY = 'test-key';
        mockPeekBudget.mockResolvedValue(0);
        mockCheckHeadroom.mockResolvedValue({ ok: true, volumes: [] });
    });

    it('lane A: true when enabled, budget clear, headroom ok', async () => {
        await expect(laneAGuardDisposition().guard(guardCtx)).resolves.toBe(true);
    });

    it('lane A: false when the hourly budget is exhausted', async () => {
        mockPeekBudget.mockResolvedValue(2000);
        await expect(laneAGuardDisposition().guard(guardCtx)).resolves.toBe(false);
    });

    it('lane A: false when the hourly budget is over the cap', async () => {
        mockPeekBudget.mockResolvedValue(2001);
        await expect(laneAGuardDisposition().guard(guardCtx)).resolves.toBe(false);
    });

    it('lane A: false when disk headroom is below margin', async () => {
        mockCheckHeadroom.mockResolvedValue({
            ok: false,
            volumes: [
                {
                    label: 'central',
                    path: '/data',
                    freeBytes: 1,
                    totalBytes: 100,
                    belowMargin: true,
                },
            ],
        });
        await expect(laneAGuardDisposition().guard(guardCtx)).resolves.toBe(false);
    });

    it('lane A: false when the kill switch is off, regardless of budget/headroom', async () => {
        configState.PROVIDER_ARTWORK_BACKFILL_ENABLED = false;
        await expect(laneAGuardDisposition().guard(guardCtx)).resolves.toBe(false);
        // Short-circuited — the budget/headroom probes never ran.
        expect(mockPeekBudget).not.toHaveBeenCalled();
        expect(mockCheckHeadroom).not.toHaveBeenCalled();
    });

    it('lane A: budget probe is skipped when the cap is <= 0 (unlimited)', async () => {
        configState.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR = 0;
        mockPeekBudget.mockResolvedValue(999_999);
        await expect(laneAGuardDisposition().guard(guardCtx)).resolves.toBe(true);
        expect(mockPeekBudget).not.toHaveBeenCalled();
    });

    it('lane A: headroom probe is skipped when the margin is <= 0', async () => {
        configState.PROVIDER_ARTWORK_MIN_FREE_GB = 0;
        await expect(laneAGuardDisposition().guard(guardCtx)).resolves.toBe(true);
        expect(mockCheckHeadroom).not.toHaveBeenCalled();
    });

    it('lane B: false when the TMDB key is absent, even with budget/headroom clear', async () => {
        configState.TMDB_API_KEY = '   ';
        await expect(laneBGuardDisposition().guard(guardCtx)).resolves.toBe(false);
    });

    it('lane B: false when the hourly budget is exhausted', async () => {
        mockPeekBudget.mockResolvedValue(2000);
        await expect(laneBGuardDisposition().guard(guardCtx)).resolves.toBe(false);
    });

    it('lane B: false when disk headroom is below margin', async () => {
        mockCheckHeadroom.mockResolvedValue({
            ok: false,
            volumes: [
                {
                    label: 'library',
                    path: '/media',
                    freeBytes: 1,
                    totalBytes: 100,
                    belowMargin: true,
                },
            ],
        });
        await expect(laneBGuardDisposition().guard(guardCtx)).resolves.toBe(false);
    });

    it('lane B: true when everything is clear', async () => {
        await expect(laneBGuardDisposition().guard(guardCtx)).resolves.toBe(true);
    });

    it('regression lock: retryAfterMs is minutes, not hours, so a resolved budget/headroom block is not stranded behind a long backoff', () => {
        // If this guard's retryAfterMs were reused at the old 6h kill-switch
        // value, the ENTIRE pending backlog would get stamped
        // skipped_transient for 6 hours every time the hourly budget was hit
        // — which happens routinely — collapsing "up to 2000/hour" throughput
        // to "up to 2000 every ~6 hours". retryAfterMs must stay well under an
        // hour so the drain resumes promptly once budget/headroom clears.
        const dA = laneAGuardDisposition();
        const dB = laneBGuardDisposition();
        expect(dA.retryAfterMs).toBeGreaterThan(0);
        expect(dA.retryAfterMs).toBeLessThanOrEqual(10 * 60 * 1000);
        expect(dB.retryAfterMs).toBeGreaterThan(0);
        expect(dB.retryAfterMs).toBeLessThanOrEqual(10 * 60 * 1000);
    });
});
