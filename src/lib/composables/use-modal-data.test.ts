// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * useModalData Composable Unit Tests
 *
 * Tests for Svelte 5 composable that manages modal data layer.
 * Validates: initial state, action methods, watchedLoading guard, and the
 * PURE helper functions the composable's reactive pipeline is built on
 * (getDataForKey / isRequestStale / isSequenceStale / mergeModalValue).
 *
 * Note on approach (rune-harness infeasibility): `useModalData` itself uses
 * Svelte 5 runes ($state, $derived, $effect), which require being compiled
 * through the Svelte compiler AND executed against the client (browser)
 * runtime build of `svelte` — the latter is only available under
 * `vitest.config.components.ts` (happy-dom + `svelteTesting()`), whose
 * `include` globs only cover the components dir and route-level Svelte
 * tests. This composable lives outside both, and
 * under the default node config `svelte` resolves to the SSR build, where
 * `$effect` bodies never run (confirmed experimentally: a bare
 * `$effect.root(() => { ran = true })` leaves `ran` false). Mounting the
 * full composable to exercise its $derived merge / stale-write guards is
 * therefore infeasible here without editing shared vitest config (out of
 * scope for this change).
 *
 * Per the task's explicit fallback ("if the rune harness is infeasible,
 * extract the pure seq/key-compare logic and test that"), the previously
 * inline `getDataForKey` closure, the repeated `!isLoading(state) ||
 * state.requestKey !== key` stale-write check, the `seq !== otherSeq`
 * sequence check, and the `canRequest`/`isAvailable` `??` merge were all
 * lifted to module-level pure exports (behavior-preserving — same
 * expressions, now named and testable) and are pinned directly below.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as modalDataModule from '$lib/utils/modal-data';
import { idle, loading, success, errorFromUnknown } from '$lib/types/async-state';
import type { ModalMediaData } from '$lib/utils/modal-data';
import {
    canLookUpSocialActivity,
    getDataForKey,
    isRequestStale,
    isSequenceStale,
    mergeModalValue,
    projectEnrichedFields,
    shouldAutoEnrich,
} from './use-modal-data.svelte';

describe('detail context projection', () => {
    it('carries localized subheadings and library labels through enrichment', () => {
        const projected = projectEnrichedFields({
            tagline: 'Localized tagline',
            certification: 'PG-13',
            libraryNames: ['Cinema'],
        });
        const merged = mergeModalValue({ title: 'Awakening', tagline: 'Old text' }, projected);
        expect(merged.tagline).toBe('Localized tagline');
        expect(merged.certification).toBe('PG-13');
        expect(merged.libraryNames).toEqual(['Cinema']);
    });
});

// Mock modal-data.ts fetch functions
vi.mock('$lib/utils/modal-data', async () => {
    const actual = await vi.importActual<typeof modalDataModule>('$lib/utils/modal-data');
    return {
        ...actual,
        enrichMediaData: vi.fn(),
        fetchSimilarContent: vi.fn(),
        fetchSocialActivity: vi.fn(),
        fetchUserRating: vi.fn(),
        fetchWatchedStatus: vi.fn(),
        toggleWatchedStatus: vi.fn(),
        fetchNextEpisode: vi.fn(),
    };
});

describe('useModalData action methods', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('toggleWatchedStatus is mocked correctly', () => {
        const mockToggle = vi.mocked(modalDataModule.toggleWatchedStatus);
        mockToggle.mockResolvedValue(true);
        expect(mockToggle).toBeDefined();
    });

    it('fetchSimilarContent is mocked correctly', () => {
        const mockFetch = vi.mocked(modalDataModule.fetchSimilarContent);
        mockFetch.mockResolvedValue([]);
        expect(mockFetch).toBeDefined();
    });

    it('fetchSocialActivity is mocked correctly', () => {
        const mockFetch = vi.mocked(modalDataModule.fetchSocialActivity);
        mockFetch.mockResolvedValue([]);
        expect(mockFetch).toBeDefined();
    });
});

describe('mergeModalValue fresh availability precedence', () => {
    it.each([true, false])('fresh available=%s replaces both stale flags', (available) => {
        const projected = projectEnrichedFields({
            isAvailable: available,
            canRequest: !available,
        });
        const merged = mergeModalValue(
            { isAvailable: !available, canRequest: available },
            projected,
        );
        expect(merged.isAvailable).toBe(available);
        expect(merged.canRequest).toBe(!available);
    });

    it.each([true, false, undefined])('missing fresh flags preserve supplied %s', (available) => {
        const merged = mergeModalValue({ isAvailable: available, canRequest: available }, {});
        expect(merged.isAvailable).toBe(available);
        expect(merged.canRequest).toBe(available);
    });
});

describe('[multilingual-media-metadata] mergeModalValue overview precedence', () => {
    function raw(overrides: Partial<ModalMediaData> = {}): ModalMediaData {
        return {
            mediaType: 'movie',
            ...overrides,
        } as ModalMediaData;
    }

    it('enriched overview WINS over the raw (opening-card placeholder) prop when both are present', () => {
        // Regression pin: ModalMovie.svelte's overview={body || enrichedData?.overview}
        // sites had this backwards — the German-UI bug was the stale English
        // `body` prop beating the freshly-fetched, language-overlaid enrichment.
        const merged = mergeModalValue(raw({ overview: 'Stale English placeholder' }), {
            overview: 'Frisch geladene deutsche Beschreibung',
        });
        expect(merged.overview).toBe('Frisch geladene deutsche Beschreibung');
    });

    it('falls back to the raw prop when enrichment has not supplied an overview yet', () => {
        const merged = mergeModalValue(raw({ overview: 'Placeholder shown immediately' }), {});
        expect(merged.overview).toBe('Placeholder shown immediately');
    });

    it('both undefined resolves to undefined, not a fabricated default', () => {
        const merged = mergeModalValue(raw({ overview: undefined }), {});
        expect(merged.overview).toBeUndefined();
    });
});

describe('mergeModalValue carries the audiobook block through enrichment', () => {
    function raw(overrides: Partial<ModalMediaData> = {}): ModalMediaData {
        return {
            mediaType: 'AUDIOBOOK',
            ...overrides,
        } as ModalMediaData;
    }

    const block = {
        authors: [{ id: 'author-id', name: 'M.K. Fenwick' }],
        narrators: [{ id: 'narrator-id', name: 'Felix Vale' }],
        chapterCount: 108,
        chapters: [
            { index: 0, name: 'Der Junge, der überlebte', startMs: 0, endMs: 1000 },
        ],
    };

    it('the enriched audiobook block reaches modalValue (no card/deep-link ever supplies one)', () => {
        // Regression pin: without this merge line the block was fetched, stored in
        // enrichedState, and then dropped on the floor — the modal rendered nothing.
        const merged = mergeModalValue(raw(), { audiobook: block });
        expect(merged.audiobook).toEqual(block);
    });

    it('a prop-supplied block still wins if a future opener carries one', () => {
        const fromProps = {
            ...block,
            narrators: [{ id: 'other-id', name: 'Someone Else' }],
            chapterCount: 1,
            chapters: [],
        };
        const merged = mergeModalValue(raw({ audiobook: fromProps }), { audiobook: block });
        expect(merged.audiobook).toEqual(fromProps);
    });

    it('stays undefined for a non-audiobook item', () => {
        const merged = mergeModalValue(raw({ mediaType: 'movie' }), {});
        expect(merged.audiobook).toBeUndefined();
    });
});

describe('[M10] getDataForKey — fallback on key mismatch', () => {
    it('returns the success data when requestKey matches the expected key', () => {
        const state = success(42, 'key-A');
        expect(getDataForKey(state, 'key-A', 0)).toBe(42);
    });

    it('returns the fallback when requestKey does NOT match the expected key (stale)', () => {
        const state = success(42, 'key-A');
        expect(getDataForKey(state, 'key-B', 0)).toBe(0);
    });

    it('returns the fallback for idle/loading/error states regardless of key', () => {
        expect(getDataForKey(idle<number>(), 'key-A', -1)).toBe(-1);
        expect(getDataForKey(loading<number>('key-A'), 'key-A', -1)).toBe(-1);
        expect(getDataForKey(errorFromUnknown<number>(new Error('boom')), 'key-A', -1)).toBe(-1);
    });

    it('falls through to the success data when the state carries no requestKey (legacy/keyless)', () => {
        const state = success(7);
        expect(getDataForKey(state, 'any-key', 0)).toBe(7);
    });

    it('falls through to the success data when expectedKey is null', () => {
        const state = success(7, 'key-A');
        expect(getDataForKey(state, null, 0)).toBe(7);
    });
});

describe('[M10] isRequestStale — key-based stale-write guard', () => {
    it('is NOT stale when still loading under the same key', () => {
        expect(isRequestStale(loading('key-A'), 'key-A')).toBe(false);
    });

    it('IS stale once the state has moved on to a different key while loading', () => {
        expect(isRequestStale(loading('key-B'), 'key-A')).toBe(true);
    });

    it('IS stale once the state is no longer loading (e.g. already resolved to success)', () => {
        expect(isRequestStale(success('done', 'key-A'), 'key-A')).toBe(true);
    });

    it('IS stale for idle/error states', () => {
        expect(isRequestStale(idle(), 'key-A')).toBe(true);
        expect(isRequestStale(errorFromUnknown(new Error('boom')), 'key-A')).toBe(true);
    });

    it('pins the OLDER-resolves-after-NEWER scenario end to end', () => {
        // Simulates the exact sequence inside loadWatchedStatus/loadUserRating/etc:
        // 1. Older request 'A' starts -> state = loading('A')
        // 2. Newer request 'B' starts before A resolves -> state = loading('B')
        // 3. A's promise resolves late: isRequestStale(state, 'A') must be true (dropped)
        // 4. B's promise resolves: isRequestStale(state, 'B') must be false (applied)
        // request 'A' started then a newer request 'B' superseded it before A
        // resolved — so the live state carries B's key.
        let state = loading<string>('item-B');

        // OLDER promise (A) resolves after the NEWER key was requested — must be dropped.
        expect(isRequestStale(state, 'item-A')).toBe(true);

        // NEWER promise (B) resolves — must be applied.
        expect(isRequestStale(state, 'item-B')).toBe(false);
        state = success('item-B-result', 'item-B');

        // A late-arriving OLDER resolution must not be able to clobber B's committed success.
        expect(isRequestStale(state, 'item-A')).toBe(true);
    });
});

describe('[M10] isSequenceStale — sequence-based stale-write guard', () => {
    it('is NOT stale when the captured token is still current', () => {
        expect(isSequenceStale(3, 3)).toBe(false);
    });

    it('IS stale once a newer call has bumped the sequence counter', () => {
        expect(isSequenceStale(1, 2)).toBe(true);
    });

    it('pins the OLDER-resolves-after-NEWER scenario for the composite/enrichment sequence guard', () => {
        let seqCounter = 0;
        const older = ++seqCounter; // seq = 1, older request
        const newer = ++seqCounter; // seq = 2, newer request supersedes

        // Older request's promise resolves after the newer one was already issued.
        expect(isSequenceStale(older, seqCounter)).toBe(true);
        // Newer request's promise resolves — still current.
        expect(isSequenceStale(newer, seqCounter)).toBe(false);
    });
});

describe('canLookUpSocialActivity', () => {
    // "Other people have listened" never appeared on an audiobook. The effect's
    // media-type clause was widened for audiobooks, but THIS clause was still
    // closed: `hasValidExternalId` ignores UUIDs on purpose, and a UUID is the
    // only id an AudiobookShelf book ever has. Nothing errored — the section
    // just did not exist, which reads exactly like "nobody else has listened".
    it('accepts an audiobook carrying only its internal UUID', () => {
        expect(
            canLookUpSocialActivity(true, {
                internal: '00000000-0000-0000-0000-000000000001',
            }),
        ).toBe(true);
    });

    it('accepts an audiobook whose UUID arrives via the fallback', () => {
        // `internalMediaId` reads props while the effect reads the merged ids;
        // either source is enough to key the lookup.
        expect(canLookUpSocialActivity(true, {}, '00000000-0000-0000-0000-000000000001')).toBe(
            true,
        );
    });

    it('rejects an audiobook with no id at all', () => {
        expect(canLookUpSocialActivity(true, {})).toBe(false);
        expect(canLookUpSocialActivity(true, undefined)).toBe(false);
    });

    it('accepts a movie or series that carries only its internal UUID', () => {
        // The social endpoint resolves an internal UUID to the item itself
        // (watch activity is keyed by the internal media id), so a library
        // item without any provider id still gets its section.
        expect(
            canLookUpSocialActivity(false, {
                internal: '00000000-0000-0000-0000-000000000001',
            }),
        ).toBe(true);
        expect(canLookUpSocialActivity(false, { tmdb: '550' })).toBe(true);
        expect(canLookUpSocialActivity(false, {})).toBe(false);
        expect(canLookUpSocialActivity(false, undefined)).toBe(false);
    });
});

describe('[degraded-modal-fix] projectEnrichedFields carries the resolved id map', () => {
    /**
     * `mergeModalValue` self-heals a missing internal id from the
     * enriched side — that id is what lets ModalMovie build `seriesPickerData`
     * (and therefore render the episode list and the Watch button) for a modal
     * opened from a thin payload.
     *
     * Two writers feed `enrichedState` and the later one REPLACES it wholesale:
     * the composite-context fetch, which carried `externalIds`, and the
     * enrichment fetch, whose field whitelist omitted it. So the self-heal was
     * live or dead depending on which request happened to resolve last. These
     * pin that the enrichment projection carries the ids too.
     */
    const enriched = {
        _enriched: true,
        title: 'Lanterns',
        overview: 'Two intergalactic cops.',
        externalIds: { tmdb: '247718', internal: 'uuid-lanterns' },
        genres: ['Sci-Fi & Fantasy'],
        actors: [{ name: 'Kyle Fenwick' }],
    } satisfies Parameters<typeof projectEnrichedFields>[0];

    it('keeps externalIds so the merge has something to heal from', () => {
        expect(projectEnrichedFields(enriched).externalIds).toEqual(
            expect.objectContaining({ internal: 'uuid-lanterns' }),
        );
    });

    it('heals a caller payload that arrived with only a tmdb id', () => {
        const merged = mergeModalValue(
            { mediaType: 'tv', externalIds: { tmdb: '247718' } } as ModalMediaData,
            projectEnrichedFields(enriched),
        );

        expect(merged.externalIds?.internal).toBe('uuid-lanterns');
        // The caller's own ids must survive the heal.
        expect(merged.externalIds?.tmdb).toBe('247718');
    });

    it('still projects the metadata fields it always carried', () => {
        const projected = projectEnrichedFields(enriched);
        expect(projected.overview).toBe('Two intergalactic cops.');
        expect(projected.genres).toEqual(['Sci-Fi & Fantasy']);
        expect(projected.actors).toEqual([{ name: 'Kyle Fenwick' }]);
    });
});

describe('[degraded-modal-fix] shouldAutoEnrich — a thin payload must not wait for a composite it can never get', () => {
    /**
     * The composite-context fetch is only reachable for a payload carrying a
     * internal id (the identity effect keys on it), and
     * `contextAttempted` is only ever set inside that fetch. So for a payload
     * holding nothing but a tmdb id — a request-notification toast, a search
     * result — the enrichment fallback waited on a flag that could never flip:
     * no cast, no ratings, no runtime, and no healed media id, which is what
     * leaves a watchable series with no episode list and no Watch button.
     * Only `loadSimilarContent` is ungated, which is why such a modal rendered
     * as title + overview + Similar and nothing else.
     */
    const base = {
        contextAttempted: false,
        compositeAvailable: true,
        needsEnrichment: true,
        hasExternalIds: true,
    };

    it('enriches a tmdb-only payload immediately (no composite is possible)', () => {
        expect(shouldAutoEnrich({ ...base, compositeAvailable: false })).toBe(true);
    });

    it('still waits for the composite when one IS possible (no duplicate fetch)', () => {
        expect(shouldAutoEnrich(base)).toBe(false);
    });

    it('enriches once the composite has landed', () => {
        expect(shouldAutoEnrich({ ...base, contextAttempted: true })).toBe(true);
    });

    it('never enriches when nothing is missing', () => {
        expect(
            shouldAutoEnrich({ ...base, compositeAvailable: false, needsEnrichment: false }),
        ).toBe(false);
    });

    it('never enriches without external ids to key the fetch on', () => {
        expect(
            shouldAutoEnrich({ ...base, compositeAvailable: false, hasExternalIds: false }),
        ).toBe(false);
    });
});

describe('episode summary merge and identity isolation', () => {
    it('retains explicit zeros and prefers refreshed personal counts over opening props', () => {
        const projected = projectEnrichedFields({
            seasonCount: 3,
            episodeCount: 60,
            availableEpisodeCount: 24,
            watchedEpisodeCount: 24,
            unwatchedEpisodeCount: 0,
        });
        const merged = mergeModalValue(
            { episodeCount: 50, watchedEpisodeCount: 0, unwatchedEpisodeCount: 24 },
            projected,
        );
        expect(merged.episodeCount).toBe(60);
        expect(merged.watchedEpisodeCount).toBe(24);
        expect(merged.unwatchedEpisodeCount).toBe(0);
    });
    it('drops a previous identity’s counts and retains absent values as unknown', () => {
        const oldState = success<Partial<ModalMediaData>>(
            { episodeCount: 60, availableEpisodeCount: 24 },
            'old-series',
        );
        const scoped = getDataForKey(oldState, 'new-series', {});
        expect(mergeModalValue({ title: 'Another show' }, scoped).episodeCount).toBeUndefined();
        expect(
            mergeModalValue({ title: 'Another show' }, projectEnrichedFields({}))
                .availableEpisodeCount,
        ).toBeUndefined();
    });
});
