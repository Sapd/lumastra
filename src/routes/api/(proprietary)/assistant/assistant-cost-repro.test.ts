// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * F14 regression guard — cost estimation must be model-aware.
 *
 * Original finding: the assistant route calculated cost with hardcoded
 * GPT-4o-mini rates ($0.15/$0.60 per 1M) regardless of `ai.openaiChatModel`,
 * so switching models silently broke cost tracking.
 *
 * Fix: the route now uses `estimateChatCostUsd(model, in, out)` from
 * `$lib/server/ai/cost`, which prices per model. This test asserts the fix
 * holds (cost varies by model) so the bug cannot regress.
 */
import { describe, it, expect } from 'vitest';
import { estimateChatCostUsd } from '$lib/server/ai/cost';

describe('F14 — assistant cost estimation is model-aware', () => {
    const ONE_M = 1_000_000;

    it('prices gpt-4o-mini at its real rate (the old hardcoded value)', () => {
        // The previously-hardcoded formula was correct ONLY for gpt-4o-mini;
        // the fix preserves that while generalizing to other models.
        expect(estimateChatCostUsd('gpt-4o-mini', ONE_M, ONE_M)).toBeCloseTo(0.15 + 0.6, 6);
    });

    it('charges materially more for an expensive model than gpt-4o-mini', () => {
        const mini = estimateChatCostUsd('gpt-4o-mini', ONE_M, ONE_M);
        const o1 = estimateChatCostUsd('o1', ONE_M, ONE_M);
        // o1 list pricing is ~100x gpt-4o-mini — must not be under-reported.
        expect(o1).toBeGreaterThan(mini * 10);
    });

    it('does not collapse every model to one hardcoded rate', () => {
        const models = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'o1', 'gpt-5'];
        const costs = models.map((m) => estimateChatCostUsd(m, ONE_M, ONE_M));
        const distinct = new Set(costs.map((c) => c.toFixed(4)));
        // Several distinct prices — proves pricing is not hardcoded.
        expect(distinct.size).toBeGreaterThanOrEqual(3);
    });
});
