// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { pipelineStepName, humanizeStageId, KNOWN_PIPELINE_STEP_IDS } from './pipeline-step-names';

describe('pipelineStepName', () => {
    it('resolves a known stage id to its friendly name', () => {
        // A step one task covers IS that task (one vocabulary, spec §1.5)…
        expect(pipelineStepName('trickplay-generation')).toBe('Generate Trickplay Images');
        // …a task covering several steps names each part.
        expect(pipelineStepName('media-probe-a')).toBe('Read Media File Details (quick)');
    });

    it('never returns the raw kebab-case id for a known stage', () => {
        for (const id of KNOWN_PIPELINE_STEP_IDS) {
            expect(pipelineStepName(id)).not.toBe(id);
        }
    });

    it('humanizes an unknown (e.g. third-party plugin) stage id', () => {
        expect(pipelineStepName('my-custom-plugin-stage')).toBe('My Custom Plugin Stage');
    });

    it('humanizes an unknown id with underscores too', () => {
        expect(pipelineStepName('some_snake_stage')).toBe('Some Snake Stage');
    });

    it('falls back to the id itself when there is nothing to split', () => {
        expect(humanizeStageId('---')).toBe('---');
    });
});

describe('humanizeStageId', () => {
    it('title-cases each hyphen-separated word', () => {
        expect(humanizeStageId('tp-gen')).toBe('Tp Gen');
    });
});
