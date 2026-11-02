// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Source guards for library-wide segment refresh and evidence ownership.
 * Failure, cancellation and checkpoint resumption are tested with real
 * PostgreSQL in intro-analyzer/bounded-drain.integration.test.ts and
 * intro-analyzer/current-input.integration.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(resolve(__dirname, '..', 'lumastra-intro-analyzer.ts'), 'utf8');

// Failed-item, cancellation and continuation behavior is exercised against real
// PostgreSQL in intro-analyzer/bounded-drain.integration.test.ts and current-input.integration.test.ts.

describe('lumastra-intro-analyzer library Outro refresh', () => {
    it('rewinds the visual stage instead of running a separate campaign', () => {
        // The standalone campaign ran a strict SUBSET of the Outro detectors
        // (chapter + blackframe) while retracting evidence from ALL of them, so
        // it permanently downgraded any episode whose best Outro came from
        // chromaprint or cohort — with no pass left to regenerate it.
        expect(source).not.toContain('analyzeLibraryOutrosOnly');
        expect(source).toContain('export async function rewindVisualStage');
    });

    // Actual global acoustic stale/current and explicit visual-only behavior is
    // exercised through execute in current-input.integration.test.ts.

    it('leaves the acoustic stage untouched so fingerprinting is not redone', () => {
        const start = source.indexOf('export async function rewindVisualStage');
        const body = source.slice(start, source.indexOf('\n}', start));
        expect(body).toContain('ANALYZER_VISUAL_STAGE_ID');
        expect(body).not.toContain('ANALYZER_ACOUSTIC_STAGE_ID');
    });

    it('retracts by DEFAULT, so every re-decide path withdraws — not just the visual one', () => {
        // The acoustic (chromaprint), anime-synth and cohort passes all call
        // resolveAndMaterialize too. Opting in per-caller meant bumping the
        // ACOUSTIC version would re-decide and still only be able to overwrite,
        // reproducing the exact bug one layer over. The default is now every
        // materializable type; callers narrow it only when they genuinely
        // re-ran a subset.
        const idx = source.indexOf('retractTypesWhenAbsent: readonly DetectedSegmentType[]');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(source.slice(idx, idx + 120)).toContain('= MATERIALIZED_SEGMENT_TYPES');
        // no caller may silently opt out with an empty list
        expect(source).not.toMatch(/resolveAndMaterialize\([^)]*\n\s*\[\],\n\s*\[\],/s);
    });

    it('retracts on BOTH paths — a targeted refresh and a full re-decide', () => {
        // A targeted Outro refresh withdraws only Outro. A full pass re-decides
        // every type it can produce, so it must be able to withdraw any of them:
        // without that the drain could overwrite a wrong marker but never remove
        // a false one, and a bad Outro written by an older detector (or orphaned
        // when its candidate was cleared) survived every later pass forever.
        // The retract list is now the run's scope, which defaults to the full
        // materializable set and narrows only when an operator asks it to.
        expect(source).toContain(
            'const FULL_SCOPE: SegmentScope = { types: MATERIALIZED_SEGMENT_TYPES',
        );
        const resolveIdx = source.lastIndexOf('return resolveAndMaterialize(');
        expect(resolveIdx).toBeGreaterThanOrEqual(0);
        expect(source.slice(resolveIdx, resolveIdx + 300)).toContain('scope.types');
        const idx = source.indexOf('const MATERIALIZED_SEGMENT_TYPES');
        expect(idx).toBeGreaterThanOrEqual(0);
        const decl = source.slice(idx, source.indexOf('];', idx));
        for (const type of ['Intro', 'Outro', 'Preview', 'Recap', 'Commercial']) {
            expect(decl).toContain(`'${type}'`);
        }
    });

    it('never lets a detector pass withdraw an operator answer', () => {
        // `manual` resolves and is safe by construction, but `stale-manual`
        // deliberately does NOT resolve — without an explicit guard it looks
        // exactly like "no evidence" and would be swept by the retraction above.
        expect(source).toContain('operatorAnsweredTypes');
        expect(source).toContain("c.method === 'manual' || c.method === 'stale-manual'");
    });
});
