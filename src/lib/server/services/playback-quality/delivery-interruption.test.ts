// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { classifyDeliveryInterruption } from './delivery-interruption';

const MBIT = 1_000_000;
describe('classifyDeliveryInterruption', () => {
    it('fires when delivery is usually fine but periodically collapses', () => {
        expect(
            classifyDeliveryInterruption(
                { windowCount: 12, p10Bps: 2 * MBIT, p50Bps: 18 * MBIT, overdueCount: 0 },
                8 * MBIT,
            ),
        ).toBe(true);
    });
    it('does not fire on a uniformly slow link (that is slow_client_connection)', () => {
        expect(
            classifyDeliveryInterruption(
                { windowCount: 12, p10Bps: 4 * MBIT, p50Bps: 5 * MBIT, overdueCount: 0 },
                8 * MBIT,
            ),
        ).toBe(false);
    });
    it('does not fire on ample, steady delivery', () => {
        expect(
            classifyDeliveryInterruption(
                { windowCount: 12, p10Bps: 15 * MBIT, p50Bps: 20 * MBIT, overdueCount: 0 },
                8 * MBIT,
            ),
        ).toBe(false);
    });
    it('needs at least three windows for the percentile rule', () => {
        expect(
            classifyDeliveryInterruption(
                { windowCount: 2, p10Bps: 1 * MBIT, p50Bps: 20 * MBIT, overdueCount: 0 },
                8 * MBIT,
            ),
        ).toBe(false);
    });
    it('fires on three or more overdue downloads regardless of bitrate knowledge', () => {
        expect(
            classifyDeliveryInterruption(
                { windowCount: 1, p10Bps: null, p50Bps: null, overdueCount: 3 },
                undefined,
            ),
        ).toBe(true);
    });
    it('is false with no windows at all', () => {
        expect(
            classifyDeliveryInterruption(
                { windowCount: 0, p10Bps: null, p50Bps: null, overdueCount: 0 },
                8 * MBIT,
            ),
        ).toBe(false);
    });
});
