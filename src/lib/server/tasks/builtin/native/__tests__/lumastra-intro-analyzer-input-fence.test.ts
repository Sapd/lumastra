// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The season cohort query and the per-item write fence ask two different
 * questions, and for a while they disagreed by accident.
 *
 * The fence (`getAnalyzerInputSnapshot`) asks "can THIS episode's segments be
 * judged?" — it wants a present, non-missing file on a live item, with a probed
 * video stream and a runtime over 60s. The cohort query asks "is this episode's
 * audio worth comparing against its siblings?", which is a weaker question: an
 * unprobed episode still sharpens the intro consensus for the rest of the
 * season even though its own segments cannot be written.
 *
 * Two of the four predicates belong to BOTH questions (a deleted item and a
 * missing file are unreadable either way) and are now applied in both places.
 * The other two are a deliberate divergence, and the fence says so out loud
 * instead of returning a bare `false` the season passes swallowed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(resolve(__dirname, '..', 'lumastra-intro-analyzer.ts'), 'utf8');
const sharedSource = readFileSync(
    resolve(__dirname, '../../../../database/queries/media-segment-input.queries.ts'),
    'utf8',
);
const flat = source.replace(/\s+/g, ' ');
const hasCode = (needle: string): boolean => flat.includes(needle.replace(/\s+/g, ' ').trim());

function fnBody(name: string): string {
    const text = [
        'getAnalyzerInputSnapshot',
        'getAnalyzerInputSnapshots',
        'analyzableVideoFileSql',
    ].includes(name)
        ? sharedSource
        : source;
    const start = text.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
    return text.slice(start, text.indexOf('\n}\n', start));
}

describe('analyzer cohort query vs write fence', () => {
    const cohort = fnBody('getEpisodesWithFilesForSeason');
    const snapshot = fnBody('getAnalyzerInputSnapshots');
    const fileFence = fnBody('analyzableVideoFileSql');

    it('never fingerprints a row nothing can read', () => {
        // ffmpeg cannot read a missing file, and a deleted item is on its way
        // out — fingerprinting either burns a full decode AND lets a stale
        // result skew the consensus for every sibling in the season.
        expect(cohort).toContain("ep.status <> 'deleted'");
        expect(cohort).toContain('analyzableVideoFileSql(sql)');
        // Both are NOT NULL DEFAULT false / 'active' in the schema, so neither
        // predicate can silently drop rows to three-valued logic.
        // Deleted self/season/series pre-selection and post-await fences are
        // verified through real consumers in current-input.integration.test.ts.
        expect(snapshot).toContain('analyzableVideoFileSql(sql)');
        expect(fileFence).toContain('NOT mf.is_missing');
    });

    it('selects an analyzable alternate consistently for readiness and cohort execution', () => {
        // Applying these here would shrink the cohort to the probed episodes and
        // weaken detection for the whole season — the opposite of the fix.
        expect(fileFence).toContain("ms.stream_type = 'video'");
        expect(fileFence).toContain('mf.duration_seconds > 60');
        expect(cohort).toContain('analyzableVideoFileSql(sql)');
        expect(snapshot).toContain('analyzableVideoFileSql(sql)');
    });
});

describe('analyzer input fence reports why it declined a write', () => {
    const fence = fnBody('analyzerInputStillCurrent');

    it('separates an ineligible item from a genuine mid-run change', () => {
        // A null snapshot is not a race. Collapsing the two into one bare
        // `false` is what made a whole test suite look like it was exercising
        // the code when every write was being dropped on the floor.
        expect(hasCode("reason: 'ineligible-input'")).toBe(true);
        expect(hasCode("reason: 'input-changed'")).toBe(true);
        expect(fence).toContain('if (current === null)');
    });

    it('still treats a hand-built snapshot as current', () => {
        // Callers outside the drain (and tests) construct EpisodeWithFile
        // without the fence fields; those must not be gated.
        expect(
            hasCode(
                'if (!input.fileId || !input.fileGeneration || !input.mediaGeneration) return true;',
            ),
        ).toBe(true);
    });

    it('hands a logger to every site that used to swallow the outcome', () => {
        // The three season-level passes returned bare. Whatever they dropped
        // left no trace anywhere.
        for (const site of [
            'analyzerInputStillCurrent(tx, episode.episodeId, episode, logger)',
            'analyzerInputStillCurrent(tx, outcome.episodeId, episode, logger)',
        ]) {
            expect(hasCode(site), `${site} does not report its outcome`).toBe(true);
        }
        // analyzeItem is the exception: it logs the discard itself.
        expect(hasCode('discarded stale detector result')).toBe(true);
    });
});
