// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runtime belt for `stage-diagnosis-display.ts`.
 *
 * The compile-time guard (an exhaustive `switch` in a `.ts` module, which tsgo
 * checks) is the primary one. This file iterates the Zod enums themselves so the
 * totality claim is also asserted against the schema's ACTUAL option list rather
 * than against a second hand-copy of it.
 *
 * It exists because the record these functions replaced had already gone stale:
 * `StuckReasonSchema` gained `'schedule-paused'` and StageDiagnosisBadge.svelte's
 * `Record<StuckReason, …>` never got the entry, so its `?? none` fallback
 * labelled an admin-paused step "Waiting". Nothing caught that — not tsgo (it
 * does not read `.svelte`), not svelte-check-native (measured 2026-08-27: a
 * deliberately renamed key in a component-local record gave 2025 files, 0
 * errors), and not a test, because there was none.
 */

import { describe, it, expect } from 'vitest';
import {
    StageOperatorStateSchema,
    StuckReasonSchema,
} from '$lib/schemas/pipeline-timeline.schema.js';
import { stageOperatorStateStyle, stuckReasonStyle } from './stage-diagnosis-display.js';

describe('stuckReasonStyle', () => {
    it('gives every schema reason a non-empty label and colour class', () => {
        for (const reason of StuckReasonSchema.options) {
            const style = stuckReasonStyle(reason);
            expect(style.label, `label for ${reason}`).toBeTruthy();
            expect(style.cls, `cls for ${reason}`).toBeTruthy();
        }
    });

    it('does not reuse one reason’s copy for another', () => {
        const labels = StuckReasonSchema.options.map((r) => stuckReasonStyle(r).label);
        expect(new Set(labels).size).toBe(labels.length);
    });

    it('says an admin switched the step off, not that it is waiting', () => {
        // The regression this module was extracted to fix: `schedule-paused` fell
        // through to the `none` entry and read "Waiting", in the same neutral
        // treatment as "nothing to report", directly beside the row's amber "Off"
        // pill. Pinned by value because the whole point is the operator reading
        // something other than the idle copy.
        const paused = stuckReasonStyle('schedule-paused');
        expect(paused.label).not.toBe(stuckReasonStyle('none').label);
        expect(paused.label.toLowerCase()).toContain('admin');
        expect(paused.cls).toContain('amber');
    });
});

describe('stageOperatorStateStyle', () => {
    it('gives every schema state its own row rule and pill', () => {
        const rows = new Set<string>();
        const pills = new Set<string>();
        for (const state of StageOperatorStateSchema.options) {
            const style = stageOperatorStateStyle(state);
            expect(style.row, `row for ${state}`).toBeTruthy();
            expect(style.pill, `pill for ${state}`).toBeTruthy();
            rows.add(style.row);
            pills.add(style.pill);
        }
        // Five visually distinct treatments — a waiting row must not read like a
        // failed one across a scanned list.
        expect(pills.size).toBe(StageOperatorStateSchema.options.length);
        expect(rows.size).toBe(StageOperatorStateSchema.options.length);
    });
});
