// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `overlaySeedTitles` (seed-title-overlay.ts).
 *
 * Covers the `titleLang` gate that the module's own doc comment calls
 * "REQUIRED, not redundant" — `feed-byw-sections.test.ts`'s `makeCtx()` never
 * sets `langs`, so that gate is otherwise never exercised.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const mockApplyTranslationOverlay = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: (...args: unknown[]) => mockApplyTranslationOverlay(...args),
}));

const { overlaySeedTitles } = await import('./seed-title-overlay.js');

const FAKE_SQL = {} as postgres.Sql;

beforeEach(() => {
    vi.clearAllMocks();
    mockApplyTranslationOverlay.mockResolvedValue(undefined);
});

describe('overlaySeedTitles', () => {
    it('does not call applyTranslationOverlay when titleLang is null (textLang-only viewer)', async () => {
        const seeds = [{ id: 's1', title: 'Original' }];

        await overlaySeedTitles(FAKE_SQL, seeds, { titleLang: null, textLang: 'de' });

        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
    });

    it('calls applyTranslationOverlay when titleLang is set, passing textLang: null', async () => {
        const seeds = [{ id: 's1', title: 'Original' }];

        await overlaySeedTitles(FAKE_SQL, seeds, { titleLang: 'de', textLang: 'de' });

        expect(mockApplyTranslationOverlay).toHaveBeenCalledTimes(1);
        const [sqlArg, itemsArg, langsArg] = mockApplyTranslationOverlay.mock.calls[0];
        expect(sqlArg).toBe(FAKE_SQL);
        expect(itemsArg).toBe(seeds);
        expect(langsArg).toEqual({ titleLang: 'de', textLang: null });
    });

    it('does not call applyTranslationOverlay for an empty seeds array', async () => {
        await overlaySeedTitles(FAKE_SQL, [], { titleLang: 'de', textLang: 'de' });

        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
    });

    it('does not call applyTranslationOverlay or throw when sql is null', async () => {
        const seeds = [{ id: 's1', title: 'Original' }];

        await expect(
            overlaySeedTitles(null, seeds, { titleLang: 'de', textLang: 'de' }),
        ).resolves.toBeUndefined();

        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
    });

    it('replaces a seed title in place via the setTitle setter passed to applyTranslationOverlay', async () => {
        const seeds = [{ id: 's1', title: 'Original Title' }];

        mockApplyTranslationOverlay.mockImplementation(
            async (
                _sql: postgres.Sql,
                items: { id: string; title: string }[],
                _langs: unknown,
                opts: { setTitle?: (item: { id: string; title: string }, value: string) => void },
            ) => {
                opts.setTitle?.(items[0], 'Translated Title');
            },
        );

        await overlaySeedTitles(FAKE_SQL, seeds, { titleLang: 'de', textLang: null });

        expect(seeds[0].title).toBe('Translated Title');
    });
});
