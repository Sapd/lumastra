// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { pipelineStepDescription } from './pipeline-step-descriptions';
import { KNOWN_PIPELINE_STEP_IDS } from './pipeline-step-names';

describe('pipelineStepDescription', () => {
    it('describes every stage id this build knows a name for', () => {
        // The `?` affordance is only worth showing if it always has something
        // to say for the steps a stock install actually runs.
        for (const id of KNOWN_PIPELINE_STEP_IDS) {
            const description = pipelineStepDescription(id, null);
            expect(description, `missing description for ${id}`).toBeTruthy();
            expect(description).not.toBe(id);
        }
    });

    it('falls back to the owning task DERIVED from a split stage id, with no taskId', () => {
        // The `?` affordance looks steps up by stage id alone. Since the
        // `task:stage` split, a split id no longer equals its task id, so
        // without the derived fallback every split stage renders bare —
        // which is exactly how `lumastra-intro-analyzer:visual` broke the
        // moment the mirror was correctly re-keyed to it.
        const split = pipelineStepDescription('lumastra-intro-analyzer:visual', null);
        expect(split).toBeTruthy();
        expect(split).toBe(pipelineStepDescription('lumastra-intro-analyzer', null));
    });

    it('gives the two probe passes distinct descriptions, not the shared task one', () => {
        const quick = pipelineStepDescription('media-probe-a', 'media-probe');
        const deep = pipelineStepDescription('media-probe-b', 'media-probe');
        expect(quick).toBeTruthy();
        expect(deep).toBeTruthy();
        expect(quick).not.toBe(deep);
    });

    it('falls back to the owning task when the stage id is not a task id', () => {
        // No stage named `metadata-sync` exists, but the task does — an
        // orphan-ish stage still gets prose from whoever owns it.
        expect(pipelineStepDescription('some-plugin-stage', 'metadata-sync')).toBe(
            pipelineStepDescription('metadata-sync'),
        );
    });

    it('returns undefined for a stage nothing knows about', () => {
        expect(pipelineStepDescription('some-plugin-stage', 'some-plugin-task')).toBeUndefined();
        expect(pipelineStepDescription('some-plugin-stage')).toBeUndefined();
    });
});
