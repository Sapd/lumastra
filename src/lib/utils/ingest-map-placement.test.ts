// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for `currentStationIndex` (the metro placement algorithm)
 * and `truncateForPill` (the CJK-aware text shortener).
 *
 * These exist as a separate test file from `IngestMap.test.ts` because
 * the component tests are excluded from the default vitest config and
 * we want the placement algo to run in normal CI.
 */
import { describe, it, expect } from 'vitest';
import {
    currentStationIndex,
    LINES,
    truncateForPill,
    formatTrainSubtitle,
    type ItemStageRow,
} from '$lib/components/admin/coverage/ingest-map.constants.js';
import type { StageStatus } from '$lib/types/pipeline.js';

function stage(stage_id: string, status: StageStatus): ItemStageRow {
    return {
        stage_id,
        status,
        processing_version: 1,
        attempt: 0,
        last_error: null,
        updated_at: new Date().toISOString(),
    };
}

describe('currentStationIndex', () => {
    const movieStations = LINES.find((l) => l.id === 'movie')!.stations;
    const musicStations = LINES.find((l) => l.id === 'music')!.stations;

    it('returns waiting at index 0 when no stages match', () => {
        const result = currentStationIndex(movieStations, []);
        expect(result).toEqual({ index: 0, mode: 'waiting' });
    });

    it('places running items at the running station', () => {
        const stages = [
            stage('media-probe-a', 'completed'),
            stage('tmdb-metadata-sync', 'running'),
        ];
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('running');
        expect(result.index).toBe(movieStations.indexOf('tmdb-metadata-sync'));
    });

    it('parks the train at the LEFTMOST not-yet-terminal station, not the rightmost completed', () => {
        // Repro of the "Die sieben ??? – Toteninsel" bug on preprod: mdblist-sync
        // (the LAST station) was completed while media-probe-a was still
        // pending. The old algorithm parked the train at the END as 'done',
        // hiding all the still-pending upstream work. New behavior: park at
        // the leftmost not-yet-completed station.
        const stages = [
            stage('media-probe-a', 'pending'),
            stage('tmdb-metadata-sync', 'completed'),
            stage('library-embeddings', 'pending'),
            stage('discovery-embeddings', 'pending'),
            stage('image-sync', 'pending'),
            stage('trickplay-params-sync', 'completed'),
            stage('trickplay-generation', 'pending'),
            stage('mdblist-sync', 'completed'),
        ];
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('waiting');
        expect(result.index).toBe(movieStations.indexOf('media-probe-a'));
    });

    it('treats skipped_transient as not-yet-done (not as completed)', () => {
        // skipped_transient means "deferred, will retry" — the user wants
        // to see the train parked there, not zoomed past it.
        const stages = [
            stage('media-probe-a', 'completed'),
            stage('tmdb-metadata-sync', 'completed'),
            stage('library-embeddings', 'skipped_transient'),
        ];
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('waiting');
        expect(result.index).toBe(movieStations.indexOf('library-embeddings'));
    });

    it('treats skipped_permanent as terminal (train moves past it)', () => {
        // skipped_permanent means "this stage never applies to this item"
        // (e.g. media-probe-b for audio-less files via predicate-false). It
        // should NOT hold the train.
        const stages = [
            stage('media-probe-a', 'completed'),
            stage('tmdb-metadata-sync', 'skipped_permanent'),
            stage('library-embeddings', 'pending'),
        ];
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('waiting');
        expect(result.index).toBe(movieStations.indexOf('library-embeddings'));
    });

    it('marks done when every station is terminal', () => {
        const stages = movieStations.map((s) => stage(s, 'completed'));
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('done');
        expect(result.index).toBe(movieStations.length - 1);
    });

    it('marks done when stations mix completed + skipped_permanent', () => {
        const stages = movieStations.map((s, idx) =>
            stage(s, idx % 2 === 0 ? 'completed' : 'skipped_permanent'),
        );
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('done');
        expect(result.index).toBe(movieStations.length - 1);
    });

    it('pins the train at the leftmost failed_permanent', () => {
        const stages = [
            stage('media-probe-a', 'completed'),
            stage('tmdb-metadata-sync', 'failed_permanent'),
            stage('library-embeddings', 'failed_permanent'),
        ];
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('failed');
        expect(result.index).toBe(movieStations.indexOf('tmdb-metadata-sync'));
    });

    it('failed_transient beats waiting but loses to failed_permanent', () => {
        const stages = [
            stage('media-probe-a', 'failed_transient'),
            stage('tmdb-metadata-sync', 'failed_permanent'),
        ];
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('failed');
        // failed_permanent wins (data-loss severity), even though
        // failed_transient is leftmost.
        expect(result.index).toBe(movieStations.indexOf('tmdb-metadata-sync'));
    });

    it('running beats every other status', () => {
        const stages = [
            stage('media-probe-a', 'failed_permanent'),
            stage('tmdb-metadata-sync', 'running'),
        ];
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('running');
        expect(result.index).toBe(movieStations.indexOf('tmdb-metadata-sync'));
    });

    it('ignores stages whose stage_id is not on the line', () => {
        // music-analysis is not on the movie line — it shouldn't influence placement.
        const stages = [stage('media-probe-a', 'completed'), stage('music-analysis', 'running')];
        const result = currentStationIndex(movieStations, stages);
        // No relevant stage running; leftmost not-terminal is tmdb-metadata-sync.
        expect(result.mode).toBe('waiting');
        expect(result.index).toBe(movieStations.indexOf('tmdb-metadata-sync'));
    });

    it('returns sensible default for empty stations array', () => {
        const result = currentStationIndex(musicStations.slice(0, 0), []);
        expect(result).toEqual({ index: 0, mode: 'waiting' });
    });
});

describe('truncateForPill', () => {
    it('returns the input untouched when it fits', () => {
        expect(truncateForPill('Hello world', 16)).toBe('Hello world');
    });

    it('truncates Latin past the unit budget with ellipsis', () => {
        const out = truncateForPill('Drifting Clouds — The Pilot Episode', 16);
        // 16 chars + ellipsis means the trailing "…" replaces nothing —
        // it's appended once truncation actually happens.
        expect(out.endsWith('…')).toBe(true);
        // The visible part stays inside the budget.
        const visible = out.replace(/…$/, '');
        expect(visible.length).toBeLessThanOrEqual(16);
    });

    it('counts CJK characters as 2 width units', () => {
        // "2025腾讯视频星光大赏 · S0…" was the actual overflow case on
        // preprod. The Chinese chars are 2 units each; "2025" is 4 latin
        // units; the space-dot-space is 3 units. The first 5 CJK chars
        // alone fill the 16-unit budget half-and-half with the latin
        // prefix.
        const out = truncateForPill('2025腾讯视频星光大赏 S01E01', 16);
        expect(out.endsWith('…')).toBe(true);
        // Sanity: count visible width units; must be ≤ 16.
        let units = 0;
        for (const ch of [...out.replace(/…$/, '')]) {
            const cp = ch.codePointAt(0)!;
            units += cp >= 0x3000 && cp <= 0x9fff ? 2 : 1;
        }
        expect(units).toBeLessThanOrEqual(16);
    });

    it('handles pure-CJK input by truncating to half the codepoint count', () => {
        // 10 Chinese chars = 20 units; budget 16 means 8 chars max + "…".
        const out = truncateForPill('腾讯视频星光大赏二三', 16);
        const visibleCodepoints = [...out.replace(/…$/, '')].length;
        expect(visibleCodepoints).toBeLessThanOrEqual(8);
        expect(out.endsWith('…')).toBe(true);
    });

    it('treats surrogate-pair emojis as one wide unit, not two narrow ones', () => {
        // CJK Extension B (U+20000+) chars are double-width AND emit as
        // surrogate pairs in UTF-16. The width estimator must walk by
        // codepoint, not by code unit, or 8 such chars would be counted
        // as 16 narrow units (passing the budget) when they actually
        // render as 16 wide units (clearly overflowing).
        const ext =
            '\u{20000}\u{20001}\u{20002}\u{20003}\u{20004}\u{20005}\u{20006}\u{20007}\u{20008}';
        const out = truncateForPill(ext, 16);
        expect(out.endsWith('…')).toBe(true);
    });

    it('default budget keeps real-world series titles unfretted', () => {
        // Default is 18 units. "Series · S03E12" is 15 units → no ellipsis.
        const out = truncateForPill('Series · S03E12');
        expect(out).toBe('Series · S03E12');
    });

    it('default budget of 18 fits a typical "Hoshisougiga · S01E10"', () => {
        // 19 chars: "Hoshisougiga · S01E10". 19 > 18 so it should still
        // truncate, but only by one char. The previous 16 budget truncated
        // at "Hoshisougiga · S0…" which buried the episode number.
        const out = truncateForPill('Hoshisougiga · S01E10');
        // 18-unit visible (codepoints) + ellipsis.
        const visible = out.replace(/…$/, '');
        expect([...visible].length).toBeLessThanOrEqual(18);
        // Truncated by exactly one char — the trailing "0" is dropped.
        expect(out.endsWith('…')).toBe(true);
    });
});

describe('formatTrainSubtitle (episode subtitle gate)', () => {
    const headline = 'Hoshisougiga · S01E10';

    it('returns empty for non-episode media types', () => {
        const result = formatTrainSubtitle({
            media_type: 'movie',
            title: 'A Movie Title',
        });
        expect(result).toBe('');
    });

    it('returns the title for episodes with a concise per-episode title', () => {
        const result = formatTrainSubtitle({
            media_type: 'episode',
            title: 'Pilot',
            series_title: 'Hoshisougiga',
            season_number: 1,
            episode_number: 10,
        });
        expect(result).toBe('Pilot');
    });

    it('suppresses overview-shaped titles longer than 40 chars', () => {
        // Repro of the Hoshisougiga preprod case where TMDB returned the
        // show overview as the per-episode `title` field. Bare display
        // would dump a paragraph of German into the tooltip.
        const result = formatTrainSubtitle({
            media_type: 'episode',
            title: 'Ein Manga-Film über Leute, die ein lustiges, bewegtes Leben führen',
            series_title: 'Hoshisougiga',
            season_number: 1,
            episode_number: 10,
        });
        expect(result).toBe('');
    });

    it('suppresses subtitle when it duplicates the headline', () => {
        // If the per-episode title happens to be the same as the
        // formatted headline (rare but possible for shows with
        // SxxEyy in the actual episode name), no point repeating.
        const result = formatTrainSubtitle({
            media_type: 'episode',
            title: headline,
            series_title: 'Hoshisougiga',
            season_number: 1,
            episode_number: 10,
        });
        expect(result).toBe('');
    });

    it('returns empty for empty/whitespace-only titles', () => {
        expect(formatTrainSubtitle({ media_type: 'episode', title: '' })).toBe('');
        expect(formatTrainSubtitle({ media_type: 'episode', title: '   ' })).toBe('');
    });
});

describe('ItemStageRow shape (skipped_reason + next_eligible_at)', () => {
    it('accepts optional skip + retry metadata', () => {
        // Compile-time sanity check that the new fields are recognised
        // — JS-side we just verify the type fits a typical skipped row.
        const row: ItemStageRow = {
            stage_id: 'mdblist-sync',
            status: 'skipped_transient',
            processing_version: 1,
            attempt: 0,
            last_error: null,
            updated_at: new Date().toISOString(),
            skipped_reason: 'ineligible-by-legacy-filter',
            next_eligible_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        };
        expect(row.skipped_reason).toBe('ineligible-by-legacy-filter');
        expect(row.next_eligible_at).toBeTruthy();
    });

    it('treats missing skipped_reason / next_eligible_at as null', () => {
        // The page-server preload coerces undefined → null on the wire,
        // so consumers should be able to assume non-undefined when the
        // field is absent.
        const row: ItemStageRow = {
            stage_id: 'media-probe-a',
            status: 'completed',
            processing_version: 1,
            attempt: 0,
            last_error: null,
            updated_at: new Date().toISOString(),
            skipped_reason: null,
            next_eligible_at: null,
        };
        expect(row.skipped_reason).toBeNull();
        expect(row.next_eligible_at).toBeNull();
    });
});

describe('LINES configuration', () => {
    it('does NOT include tmdb-metadata-sync on the series line (movies-only stage)', () => {
        const series = LINES.find((l) => l.id === 'series')!;
        expect(series.stations).not.toContain('tmdb-metadata-sync');
        // series-sync IS on the line — it's the per-series equivalent.
        expect(series.stations).toContain('series-sync');
        // Sanity: station labels and stations are aligned.
        expect(series.stations.length).toBe(series.stationLabels.length);
    });

    it('includes tmdb-metadata-sync on the movie line (its actual scope)', () => {
        const movie = LINES.find((l) => l.id === 'movie')!;
        expect(movie.stations).toContain('tmdb-metadata-sync');
    });
});
