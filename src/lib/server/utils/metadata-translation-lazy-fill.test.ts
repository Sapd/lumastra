// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHasTranslation, mockStartRun } = vi.hoisted(() => ({
    mockHasTranslation: vi.fn(),
    mockStartRun: vi.fn(),
}));

vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    hasTranslation: mockHasTranslation,
}));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: mockStartRun,
    },
}));

vi.mock('./logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

import { triggerMetadataTranslationLazyFill } from './metadata-translation-lazy-fill.js';

/** sql stub that is ALSO callable as a tagged template (the lazy-fill IIFE
 * queries the stage row directly); defaults to no stage row. */
function makeSql(stageRow: { status: string }[] = []) {
    return vi.fn().mockResolvedValue(stageRow) as unknown as Parameters<
        typeof triggerMetadataTranslationLazyFill
    >[0];
}

const USER_ID = 'usr_00000000-0000-0000-0000-000000000001';

describe('triggerMetadataTranslationLazyFill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('enqueues with the stage-sweep coverage idempotencyKey when no translation exists', async () => {
        mockHasTranslation.mockResolvedValue(false);
        mockStartRun.mockResolvedValue({ deduped: false });

        triggerMetadataTranslationLazyFill(
            makeSql(),
            'movie-uuid',
            'movie',
            USER_ID,
            { titleLang: 'de', textLang: 'de' },
            { sourceRoute: 'media-detail' },
        );

        await vi.waitFor(() => expect(mockStartRun).toHaveBeenCalledTimes(1));
        expect(mockStartRun).toHaveBeenCalledWith(
            'metadata-translations-sync',
            { mediaItemId: 'movie-uuid' },
            expect.objectContaining({
                idempotencyKey: 'coverage:metadata-translations-sync:movie-uuid',
                trigger: expect.objectContaining({ sourceRoute: 'media-detail' }),
            }),
        );
    });

    it('does not enqueue when a translation already exists', async () => {
        mockHasTranslation.mockResolvedValue(true);

        triggerMetadataTranslationLazyFill(
            makeSql(),
            'movie-uuid',
            'movie',
            USER_ID,
            { titleLang: 'de', textLang: null },
            { sourceRoute: 'media-detail' },
        );

        await vi.waitFor(() => expect(mockHasTranslation).toHaveBeenCalled());
        await new Promise((resolve) => setImmediate(resolve));
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('does not enqueue when the stage row is in a terminal state', async () => {
        mockHasTranslation.mockResolvedValue(false);

        triggerMetadataTranslationLazyFill(
            makeSql([{ status: 'skipped_permanent' }]),
            'movie-uuid',
            'movie',
            USER_ID,
            { titleLang: 'de', textLang: null },
            { sourceRoute: 'media-detail' },
        );

        await vi.waitFor(() => expect(mockHasTranslation).toHaveBeenCalled());
        await new Promise((resolve) => setImmediate(resolve));
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('is a no-op (zero queries) when userId is undefined', async () => {
        triggerMetadataTranslationLazyFill(
            makeSql(),
            'movie-uuid',
            'movie',
            undefined,
            { titleLang: 'de', textLang: null },
            { sourceRoute: 'media-detail' },
        );

        await new Promise((resolve) => setImmediate(resolve));
        expect(mockHasTranslation).not.toHaveBeenCalled();
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('is a no-op when both langs are null (primary language)', async () => {
        triggerMetadataTranslationLazyFill(
            makeSql(),
            'movie-uuid',
            'movie',
            USER_ID,
            { titleLang: null, textLang: null },
            { sourceRoute: 'media-detail' },
        );

        await new Promise((resolve) => setImmediate(resolve));
        expect(mockHasTranslation).not.toHaveBeenCalled();
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it.each(['episode', 'season', 'audiobook'])(
        'is a no-op for publicType %s (movie/series only)',
        async (publicType) => {
            triggerMetadataTranslationLazyFill(
                makeSql(),
                'item-uuid',
                publicType,
                USER_ID,
                { titleLang: 'de', textLang: null },
                { sourceRoute: 'media-detail' },
            );

            await new Promise((resolve) => setImmediate(resolve));
            expect(mockHasTranslation).not.toHaveBeenCalled();
            expect(mockStartRun).not.toHaveBeenCalled();
        },
    );

    it('enqueues for publicType series', async () => {
        mockHasTranslation.mockResolvedValue(false);
        mockStartRun.mockResolvedValue({ deduped: false });

        triggerMetadataTranslationLazyFill(
            makeSql(),
            'series-uuid',
            'series',
            USER_ID,
            { titleLang: 'de', textLang: null },
            { sourceRoute: 'media-detail' },
        );

        await vi.waitFor(() => expect(mockStartRun).toHaveBeenCalledTimes(1));
    });

    it('prefers titleLang over textLang when checking/enqueueing', async () => {
        mockHasTranslation.mockResolvedValue(false);
        mockStartRun.mockResolvedValue({ deduped: false });

        triggerMetadataTranslationLazyFill(
            makeSql(),
            'movie-uuid',
            'movie',
            USER_ID,
            { titleLang: 'de', textLang: 'fr' },
            { sourceRoute: 'media-detail' },
        );

        await vi.waitFor(() =>
            expect(mockHasTranslation).toHaveBeenCalledWith(expect.anything(), 'movie-uuid', 'de'),
        );
    });

    it('falls back to textLang when titleLang is null', async () => {
        mockHasTranslation.mockResolvedValue(false);
        mockStartRun.mockResolvedValue({ deduped: false });

        triggerMetadataTranslationLazyFill(
            makeSql(),
            'movie-uuid',
            'movie',
            USER_ID,
            { titleLang: null, textLang: 'fr' },
            { sourceRoute: 'media-detail' },
        );

        await vi.waitFor(() =>
            expect(mockHasTranslation).toHaveBeenCalledWith(expect.anything(), 'movie-uuid', 'fr'),
        );
    });

    it('does not throw when startRun rejects — failure is caught and logged', async () => {
        mockHasTranslation.mockResolvedValue(false);
        mockStartRun.mockRejectedValue(new Error('orchestrator unavailable'));

        expect(() =>
            triggerMetadataTranslationLazyFill(
                makeSql(),
                'movie-uuid',
                'movie',
                USER_ID,
                { titleLang: 'de', textLang: null },
                { sourceRoute: 'media-detail' },
            ),
        ).not.toThrow();

        await vi.waitFor(() => expect(mockStartRun).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setImmediate(resolve));
    });
});
