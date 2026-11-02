// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `outroOnly` conflated two independent axes: which DETECTORS a pass runs, and
 * which segment TYPES its resolver may decide and retract. Splitting it into
 * `SegmentScope { types, visualOnly }` is what makes an Intro-scoped run
 * possible at all — chromaprint is the primary Intro detector, so a straight
 * rename of the flag would have produced an "Intros only" run with the intro
 * detector switched off.
 *
 * The module has server-only imports and the scope plumbing is module-private,
 * so — matching the convention already established by the sibling coverage
 * tests — the invariants are asserted against the source.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(resolve(__dirname, '..', 'lumastra-intro-analyzer.ts'), 'utf8');

/**
 * Whitespace-insensitive source match.
 *
 * Asserting an exact line is a trap here: lint-staged runs `prettier --write`
 * during the commit itself, so a line that was one statement when the suite last
 * ran can be wrapped across three by the time it lands. Collapsing runs of
 * whitespace on both sides keeps these assertions about the CODE rather than
 * about the formatter's column budget.
 */
const flat = source.replace(/\s+/g, ' ');
const hasCode = (needle: string): boolean => flat.includes(needle.replace(/\s+/g, ' ').trim());

describe('lumastra-intro-analyzer segment scope', () => {
    it('gates chromaprint on the DETECTOR axis, never on the requested types', () => {
        // The whole point of the split. Gating chroma on the type scope would
        // disable acoustic detection for an Intro-scoped run, which is the one
        // scope that needs it most.
        expect(hasCode('const doChroma = !scope.visualOnly && config.chromaprint')).toBe(true);
        expect(source).not.toMatch(/doChroma\s*=\s*[^;]*scope\.types/);
    });

    it('keeps a library-wide refresh on the full detector set', () => {
        // A library-wide request rewinds the visual stage and rejoins the
        // ordinary drain; only a run aimed at an explicit item or season drops
        // to the cheap per-item detectors.
        expect(hasCode('visualOnly: hasExplicitTarget')).toBe(true);
    });

    it('marks an item analyzed only when the full detector set ran', () => {
        // A scoped visual-only pass must not satisfy the stage version, or the
        // drain would never revisit the item to run the detectors it skipped.
        expect(hasCode('if (fullCoverage) { await upsertCompletedRow')).toBe(true);
        expect(
            hasCode('MATERIALIZED_SEGMENT_TYPES.every((type) => scope.types.includes(type))'),
        ).toBe(true);
        expect(hasCode('if (toMark.length > 0 && !signal.aborted) {')).toBe(true);
    });

    it('retracts exactly the scoped types, on both the delete and the resolve', () => {
        // Retraction narrower than the candidate filter would leave a stale
        // marker with no candidate behind it; wider would withdraw a type the
        // operator never asked about.
        expect(source).toContain(
            'detected.filter((segment) => scope.types.includes(segment.type))',
        );
        expect(hasCode('AND type = ANY(${scopedTypes}::text[])')).toBe(true);
        const resolveIdx = source.lastIndexOf('return resolveAndMaterialize(');
        expect(source.slice(resolveIdx, resolveIdx + 300)).toContain('scope.types');
    });

    it('preserves out-of-scope evidence for a method it re-ran', () => {
        // A visual-only Intro refresh re-runs chapter+blackframe, which also
        // produce Outro. Replacing the method wholesale would drop that Outro
        // evidence, so anything outside the scope is carried forward.
        expect(
            hasCode(
                'if ( scope.types.includes(candidate.type) || !ownedMethods.includes(candidate.method) )',
            ),
        ).toBe(true);
    });

    it('still accepts outroOnly, since the per-item admin surfaces send it', () => {
        // SyncTab and POST /api/admin/media/{id}/segments both send the retired
        // spelling and are always targeted.
        expect(hasCode("if (rawInput.outroOnly === true) return ['Outro'];")).toBe(true);
    });

    it('rejects an unrecognised segmentTypes rather than widening to everything', () => {
        // Silently treating a typo as "no scope" would retract every type the
        // operator did not ask about — the exact failure the scope prevents.
        expect(source).toContain('segmentTypes named no known type');
        expect(source).toContain(
            "throw new Error('lumastra-intro-analyzer: segmentTypes must be an array')",
        );
    });

    it('carries the scope through EVERY pass the drain fans out to', () => {
        // The scope is useless if only `analyzeItem` honours it: a library-wide
        // run also reaches chromaprint, the season cohort reconciliation and the
        // anime-preview synthesis, each with its own resolve. Any one of them
        // left unscoped would re-decide -- and retract -- the types the operator
        // asked to leave alone.
        for (const fn of [
            'async function analyzeSliceOfSeasons(',
            'async function analyzeSingleEpisodeFallback(',
            'export async function analyzeSingleSeasonChromaprint(',
            'export async function reconcileAndMaterializeSeason(',
        ]) {
            const idx = source.indexOf(fn);
            expect(idx, `${fn} not found`).toBeGreaterThanOrEqual(0);
            const sig = source.slice(idx, source.indexOf('): Promise', idx));
            expect(sig, `${fn} does not accept a scope`).toContain(
                'scope: SegmentScope = FULL_SCOPE',
            );
        }
        // No resolve inside the analyzer may fall back to the default retract
        // list, which is every type.
        const resolveCalls = source.split('await resolveAndMaterialize(').slice(1);
        expect(resolveCalls.length).toBeGreaterThanOrEqual(3);
        for (const call of resolveCalls) {
            expect(call.slice(0, 400)).toContain('scope.types');
        }
    });

    it('writes only the scoped types, so the others keep their exact rows', () => {
        // `upsertSegments` touches only the types handed to it, so narrowing the
        // write scope is what makes "outros are left exactly as they are" true
        // rather than "outros are recomputed and usually land in the same place".
        expect(
            hasCode(
                'const materialized = resolved.filter((segment) => materializeTypes.includes(segment.type))',
            ),
        ).toBe(true);
        // Retraction must still see the FULL resolved set, or a type that
        // resolved outside the write scope would read as an abstention.
        const idx = source.indexOf('const typesToRetract = retractTypesWhenAbsent.filter(');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(source.slice(idx, idx + 300)).toContain('!resolved.some(');
    });

    it('separates two scoped requests over the same seasons in the run identity', () => {
        // Identity collapse is deliberate for library-wide runs, but an Intro
        // request and an Outro request decide different things and must not
        // dedupe onto one another.
        const idx = source.indexOf('identityFor:');
        const body = source.slice(idx, idx + 1200);
        expect(body).toContain('segmentTypes');
    });
});
