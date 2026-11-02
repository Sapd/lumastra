// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Intro-analyzer coverage table eligibility tests.
 *
 * Verifies that `getUnanalyzedSeasons` and
 * `getUnanalyzedSingleEpisodeSeasonEpisodes` now consult
 * `media_item_stage_state` instead of `plugin_analysis_log` when deciding
 * whether an episode has already been analyzed.
 *
 * Also verifies that `markAnalyzed` and `wipeAll` no longer reference
 * `plugin_analysis_log` — the table was dropped in migration 16.4.0.
 *
 * These are unit tests — they inspect the SQL strings produced by the
 * helper functions rather than running against a real database.
 */

import { describe, it, expect } from 'vitest';

// The eligibility predicates are module-private functions in
// lumastra-intro-analyzer.ts. Rather than expose them for test-only imports,
// we verify the behaviour by reading the compiled source as a string and
// asserting that:
//   1. `media_item_stage_state` appears as the eligibility source.
//   2. `plugin_analysis_log` does NOT appear anywhere in the file.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const sourceFile = resolve(__dirname, '..', 'lumastra-intro-analyzer.ts');
const source = readFileSync(sourceFile, 'utf8');

describe('lumastra-intro-analyzer: eligibility uses coverage table', () => {
    it('getUnanalyzedSeasons queries media_item_stage_state', () => {
        const fnStart = source.indexOf('async function getUnanalyzedSeasons(');
        const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
        const fnBody = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);

        expect(fnBody).toContain('media_item_stage_state');
        // Resolved = completed OR poison-quarantined (skipped_permanent).
        expect(fnBody).toContain("miss.status IN ('completed', 'skipped_permanent')");
        expect(fnBody).toContain('miss.processing_version >=');
    });

    it('getUnanalyzedSeasons does not use plugin_analysis_log for eligibility', () => {
        const fnStart = source.indexOf('async function getUnanalyzedSeasons(');
        const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
        const fnBody = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);

        expect(fnBody).not.toContain('plugin_analysis_log');
    });

    it('getUnanalyzedSingleEpisodeSeasonEpisodes queries media_item_stage_state', () => {
        const fnStart = source.indexOf('async function getUnanalyzedSingleEpisodeSeasonEpisodes(');
        const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
        const fnBody = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);

        expect(fnBody).toContain('media_item_stage_state');
        expect(fnBody).toContain("miss.status IN ('completed', 'skipped_permanent')");
    });

    it('getUnanalyzedSingleEpisodeSeasonEpisodes does not use plugin_analysis_log for eligibility', () => {
        const fnStart = source.indexOf('async function getUnanalyzedSingleEpisodeSeasonEpisodes(');
        const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
        const fnBody = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);

        expect(fnBody).not.toContain('plugin_analysis_log');
    });

    it('countBacklog queries media_item_stage_state', () => {
        const fnStart = source.indexOf('async function countBacklog(');
        const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
        const fnBody = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);

        expect(fnBody).toContain('media_item_stage_state');
    });

    it('markAnalyzed does not reference plugin_analysis_log (table retired in 16.4.0)', () => {
        const fnStart = source.indexOf('async function markAnalyzed(');
        const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
        const fnBody = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);

        expect(fnBody).not.toContain('plugin_analysis_log');
        expect(fnBody).toContain('upsertCompletedRow');
    });

    it('wipeAll does not reference plugin_analysis_log (table retired in 16.4.0)', () => {
        const fnStart = source.indexOf('async function wipeAll(');
        const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
        const fnBody = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);

        expect(fnBody).not.toContain('plugin_analysis_log');
        expect(fnBody).toContain('media_item_stage_state');
    });

    it('wipeAll excludes writers before its snapshot and deletes evidence before rows', () => {
        const fnStart = source.indexOf('async function wipeAll(');
        const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
        const fnBody = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);

        const lock = fnBody.indexOf('acquireExclusiveMediaSegmentWriteGate');
        const generation = fnBody.indexOf('bumpGlobalMediaSegmentAnalysisGeneration');
        const snapshot = fnBody.indexOf('const affectedRows');
        const candidates = fnBody.indexOf('DELETE FROM media_segment_candidates');
        const segments = fnBody.indexOf('DELETE FROM media_segments');

        expect(fnBody).toContain('ORDER BY "mediaId"');
        expect(lock).toBeGreaterThan(-1);
        expect(generation).toBeGreaterThan(lock);
        expect(snapshot).toBeGreaterThan(-1);
        expect(generation).toBeLessThan(snapshot);
        expect(snapshot).toBeLessThan(candidates);
        expect(candidates).toBeLessThan(segments);
    });

    it('targeted reset paths lock before deleting candidates, then segments', () => {
        const singleStart = source.indexOf('if (targetMediaId)');
        const singleEnd = source.indexOf('// Admin-targeted: season', singleStart);
        const single = source.slice(singleStart, singleEnd);
        const singleLock = single.indexOf('acquireMediaSegmentResolutionLock');
        const singleGeneration = single.indexOf('bumpMediaSegmentAnalysisGeneration');
        const singleCandidates = single.indexOf('deleteCandidatesForMedia');
        const singleSegments = single.indexOf('DELETE FROM media_segments');
        expect(singleLock).toBeGreaterThan(-1);
        expect(singleCandidates).toBeGreaterThan(-1);
        expect(singleSegments).toBeGreaterThan(-1);
        expect(singleLock).toBeLessThan(singleCandidates);
        expect(singleLock).toBeLessThan(singleGeneration);
        expect(singleGeneration).toBeLessThan(singleCandidates);
        expect(singleCandidates).toBeLessThan(singleSegments);

        const bulkStart = source.indexOf('if (targetingRequested)');
        const bulkEnd = source.indexOf('const episodeRows', bulkStart);
        const bulk = source.slice(bulkStart, bulkEnd);
        const bulkLock = bulk.indexOf('acquireMediaSegmentResolutionLocks');
        const bulkGeneration = bulk.indexOf('bumpMediaSegmentAnalysisGeneration');
        const bulkCandidates = bulk.indexOf('DELETE FROM media_segment_candidates');
        const bulkSegments = bulk.indexOf('DELETE FROM media_segments');
        expect(bulk).toContain('ORDER BY id');
        expect(bulkLock).toBeGreaterThan(-1);
        expect(bulkCandidates).toBeGreaterThan(-1);
        expect(bulkSegments).toBeGreaterThan(-1);
        expect(bulkLock).toBeLessThan(bulkCandidates);
        expect(bulkLock).toBeLessThan(bulkGeneration);
        expect(bulkGeneration).toBeLessThan(bulkCandidates);
        expect(bulkCandidates).toBeLessThan(bulkSegments);
    });

    it('revalidates detector input under the item lock before persistence', () => {
        const fnStart = source.indexOf('async function analyzeItem(');
        const fnEnd = source.indexOf(
            '\nexport async function analyzeSingleSeasonChromaprint(',
            fnStart,
        );
        const fnBody = source.slice(fnStart, fnEnd);
        const lock = fnBody.lastIndexOf('acquireMediaSegmentResolutionLock');
        const revalidation = fnBody.indexOf('analyzerInputStillCurrent(tx, mediaId, info)');
        const persistence = fnBody.indexOf('replaceCandidatesForMethods', revalidation);

        expect(lock).toBeGreaterThan(-1);
        expect(revalidation).toBeGreaterThan(lock);
        expect(persistence).toBeGreaterThan(revalidation);
        expect(fnBody).toContain('analyzerInputStillCurrent(tx, mediaId, info)');
    });

    it('plugin_analysis_log does not appear anywhere in the source', () => {
        expect(source).not.toContain('plugin_analysis_log');
    });
});
