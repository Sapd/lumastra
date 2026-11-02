// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A manual window edit emits `file.windowChanged` (manual-file-links.service.ts).
 * The stages whose output depends on an episode's window inside its file must
 * re-run on it; with the outbox on, nothing else reaches them, because the
 * link row's trigger fires only on insert, delete and a new default.
 */

import { describe, it, expect } from 'vitest';
import { PIPELINE_EVENT_NAMES } from '$lib/types/pipeline.js';
import {
    lumastraIntroAnalyzerTask,
    ANALYZER_VISUAL_STAGE_ID,
} from '$lib/server/tasks/builtin/native/lumastra-intro-analyzer.js';

describe('file.windowChanged', () => {
    it('is a pipeline event', () => {
        expect(PIPELINE_EVENT_NAMES).toContain('file.windowChanged');
    });

    it('re-runs intro/credits detection, which reads the episode window', () => {
        const stage = (
            lumastraIntroAnalyzerTask.coversStages as ReadonlyArray<{
                id: string;
                invalidatedBy?: readonly string[];
                preserveCompletedOn?: readonly string[];
            }>
        ).find((s) => s.id === ANALYZER_VISUAL_STAGE_ID);
        expect(stage?.invalidatedBy).toContain('file.windowChanged');
        expect(stage?.preserveCompletedOn ?? []).not.toContain('file.windowChanged');
    });
});
