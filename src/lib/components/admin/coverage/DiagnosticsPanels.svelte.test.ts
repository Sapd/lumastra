// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import { IngestDiagnosticsResponseSchema } from '$lib/api/admin.js';
import DiagnosticsPanels from './DiagnosticsPanels.svelte';
afterEach(cleanup);
it('shows the forwarded SQL reason and an honest fallback for legacy snapshots', () => {
    const diagnostics = IngestDiagnosticsResponseSchema.parse({
        summary: {
            inFlight: 0,
            failedLastHour: 0,
            deadLetterItems: 0,
            running: 0,
            oldestPendingAgeSec: null,
            degradedItems: 0,
        },
        stuckItems: [
            {
                media_item_id: 'reason-recorded',
                title: 'Recorded reason',
                series_title: null,
                season_number: null,
                episode_number: null,
                media_type: 'movie',
                stage_id: 'probe',
                status: 'running',
                attempt: 3,
                reason: 'running_stale',
                last_error: null,
                stuck_since: '2026-10-25T10:00:00Z',
                stuck_age_sec: 900,
            },
        ],
        deadLetter: [],
        errorGroups: [],
    });
    const legacy = IngestDiagnosticsResponseSchema.parse({
        summary: {
            inFlight: 0,
            failedLastHour: 0,
            deadLetterItems: 0,
            running: 0,
            oldestPendingAgeSec: null,
            degradedItems: 0,
        },
        stuckItems: [
            {
                media_item_id: 'legacy-reason',
                title: 'Legacy reason',
                series_title: null,
                season_number: null,
                episode_number: null,
                media_type: 'movie',
                stage_id: 'probe',
                status: 'pending',
                attempt: 0,
                last_error: null,
                stuck_since: '2026-10-25T10:00:00Z',
                stuck_age_sec: 900,
            },
        ],
        deadLetter: [],
        errorGroups: [],
    });
    render(DiagnosticsPanels, {
        stuckItems: [...diagnostics.stuckItems, ...legacy.stuckItems],
        errorGroups: [],
        deadLetter: [],
    });

    expect(document.body.textContent).toContain('Selected reason:');
    expect(document.body.textContent).toContain('Recorded as running');
    expect(document.body.textContent).toContain('Reason was not recorded in this snapshot');
    expect(document.body.textContent).not.toMatch(/repeated failures|exhausted/i);
});
it.each([0, 1, 5])(
    'describes stopped retrying without inventing repeated failures at attempt %s',
    async (attempt) => {
        render(DiagnosticsPanels, {
            stuckItems: [],
            errorGroups: [],
            deadLetter: [
                {
                    media_item_id: 'fictional-item',
                    title: 'Fictional source',
                    series_title: null,
                    season_number: null,
                    episode_number: null,
                    media_type: 'movie',
                    stage_id: 'lumastra-intro-analyzer:visual',
                    attempt,
                    last_error: {
                        message:
                            'Video packet timestamps do not advance despite sustained positive packet durations; repair the source file before retrying analysis',
                    },
                    dead_since: '2026-10-24T10:00:00Z',
                    dead_age_sec: 60,
                },
            ],
        });
        expect(document.body.textContent).not.toMatch(/repeated failures|exhausted/i);
        await fireEvent.click(screen.getByRole('button', { name: 'Show full error' }));
        expect(document.body.textContent).toContain('Repair or replace the source file');
        expect(document.body.textContent).toContain('support');
    },
);
it('retains an unknown permanent error without guessing its source or retry history', () => {
    render(DiagnosticsPanels, {
        stuckItems: [],
        errorGroups: [],
        deadLetter: [
            {
                media_item_id: 'fictional-item',
                title: 'Fictional source',
                series_title: null,
                season_number: null,
                episode_number: null,
                media_type: 'movie',
                stage_id: 'probe',
                attempt: 0,
                last_error: { message: 'Unknown permanent error' },
                dead_since: '2026-10-24T10:00:00Z',
                dead_age_sec: 60,
            },
        ],
    });
    expect(document.body.textContent).toContain('Unknown permanent error');
    expect(document.body.textContent).not.toMatch(
        /repeated failures|exhausted|damaged|Repair or replace/i,
    );
});
