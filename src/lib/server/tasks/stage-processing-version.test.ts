// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The stage-vs-task eligibility version, and the analyzer declaration that
 * makes the defect it was written for impossible to reintroduce.
 *
 * 🔴 `detectVersionBumps` compares a declared version against
 * `stage_version_state` to decide which completed rows are stale. It read the
 * TASK's `processingVersion` while `markAnalyzed` stamped the STAGE's — on prod
 * the ledger held 4 while all 14,651 completed `:visual` rows held 5. Both
 * directions were broken: bumping the real per-stage constant marked nothing
 * obsolete, and bumping the task's provenance constant would have re-analysed
 * every row its own docstring says must never be re-analysed.
 *
 * One task, two stages that advance independently, one number — the number was
 * never going to describe both.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stageProcessingVersion } from './stage-processing-version.js';
import { ANALYZER_VISUAL_VERSION } from './builtin/native/intro-analyzer/settings.js';

describe('stageProcessingVersion', () => {
    it('prefers the stage version when the stage declares one', () => {
        expect(stageProcessingVersion({ processingVersion: 4 }, { processingVersion: 5 })).toBe(5);
    });

    it('falls back to the task version when the stage omits it', () => {
        // Every task that predates the field omits it, so this path must be
        // byte-identical to the old behaviour.
        expect(stageProcessingVersion({ processingVersion: 7 }, {})).toBe(7);
    });

    it('lets a stage pin a LOWER version than its task', () => {
        // Provenance moves for reasons eligibility does not; a stage is allowed
        // to sit behind its task rather than being dragged along by it.
        expect(stageProcessingVersion({ processingVersion: 9 }, { processingVersion: 2 })).toBe(2);
    });

    it('treats an explicit undefined as absent, not as zero', () => {
        expect(
            stageProcessingVersion({ processingVersion: 3 }, { processingVersion: undefined }),
        ).toBe(3);
    });
});

describe('the intro-analyzer declares its own stage version', () => {
    // Read as source text rather than importing: the analyzer module is ~3,600
    // lines with heavy imports, and this assertion only needs the declaration.
    const source = readFileSync(
        join(process.cwd(), 'src/lib/server/tasks/builtin/native/lumastra-intro-analyzer.ts'),
        'utf8',
    );

    it('pins the visual stage to VISUAL_PROCESSING_VERSION, not the task value', () => {
        // 🔴 The actual invariant that broke. Without this line the stage
        // inherits the task's provenance constant and the ledger drifts from
        // the rows again, silently.
        expect(source).toMatch(
            /id:\s*ANALYZER_VISUAL_STAGE_ID,[\s\S]{0,900}?processingVersion:\s*VISUAL_PROCESSING_VERSION,/,
        );
    });

    it('still separates the provenance constant from the visual one', () => {
        // If these ever collapse to one number the whole distinction is gone
        // and the next detector change re-fingerprints the library.
        const provenance = /const PROCESSING_VERSION = (\d+)/.exec(source)?.[1];
        // d046376876 shares the detector version with input/failure queries.
        // Keep the stage wired to that single source, independently of provenance.
        expect(source).toMatch(/const VISUAL_PROCESSING_VERSION = ANALYZER_VISUAL_VERSION;/);
        expect(provenance).toBeDefined();
        expect(ANALYZER_VISUAL_VERSION).toBeGreaterThan(0);
        expect(Number(provenance)).not.toBe(ANALYZER_VISUAL_VERSION);
    });
});
