// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import PipelineProgressStrip from './PipelineProgressStrip.svelte';
import type { StageStateRow, StageStatus } from '$lib/types/pipeline.js';

function makeRow(stage_id: string, status: StageStatus = 'completed'): StageStateRow {
    return {
        media_item_id: 'test-item-id',
        stage_id,
        processing_version: 1,
        status,
        attempt: 0,
        last_run_id: null,
        last_error: null,
        skipped_reason: null,
        started_at: null,
        completed_at: null,
        next_eligible_at: null,
        updated_at: new Date(),
    };
}

describe('PipelineProgressStrip', () => {
    test('renders one StageCell per row', () => {
        const rows = [
            makeRow('media-probe'),
            makeRow('music-analysis'),
            makeRow('library-embeddings'),
        ];
        const { container } = render(PipelineProgressStrip, { rows });
        const spans = container.querySelectorAll('span[role="img"]');
        expect(spans).toHaveLength(3);
    });

    test('shows placeholder when rows is empty', () => {
        const { container } = render(PipelineProgressStrip, { rows: [] });
        const placeholder = container.querySelector('[aria-label="No stage coverage data"]');
        expect(placeholder).not.toBeNull();
        const spans = container.querySelectorAll('span[role="img"]');
        expect(spans).toHaveLength(0);
    });

    test('calls onStageClick with the correct stage_id when a cell is clicked', async () => {
        const user = userEvent.setup();
        const onStageClick = vi.fn();
        const rows = [makeRow('media-probe', 'pending'), makeRow('music-analysis', 'running')];

        render(PipelineProgressStrip, { rows, onStageClick });

        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(2);

        await user.click(buttons[0]);
        expect(onStageClick).toHaveBeenCalledTimes(1);
        // rows are sorted alphabetically: library-embeddings < media-probe < music-analysis
        // but we only have 2 rows: media-probe < music-analysis
        expect(onStageClick).toHaveBeenCalledWith('media-probe');
    });

    test('renders cells in alphabetical stage_id order', () => {
        const rows = [makeRow('z-stage'), makeRow('a-stage'), makeRow('m-stage')];
        const { container } = render(PipelineProgressStrip, { rows });
        const spans = container.querySelectorAll('span[role="img"]');
        // Cells are labelled with the friendly step name, so an unknown id
        // surfaces humanized ('a-stage' → 'A Stage') — order still holds.
        const labels = Array.from(spans).map((s) => s.getAttribute('aria-label') ?? '');
        expect(labels[0]).toContain('A Stage');
        expect(labels[1]).toContain('M Stage');
        expect(labels[2]).toContain('Z Stage');
    });

    test('does not render buttons when onStageClick is not provided', () => {
        const rows = [makeRow('media-probe'), makeRow('music-analysis')];
        render(PipelineProgressStrip, { rows });
        const buttons = screen.queryAllByRole('button');
        expect(buttons).toHaveLength(0);
    });

    test('drops the native title so only the styled Tooltip fires on hover', () => {
        // Two bubbles on one hover (browser `title` + <Tooltip>) is the exact
        // regression this guards; the aria-label must survive regardless.
        const { container } = render(PipelineProgressStrip, { rows: [makeRow('mdblist-sync')] });
        const cell = container.querySelector('span[role="img"]');
        expect(cell).not.toBeNull();
        expect(cell!.hasAttribute('title')).toBe(false);
        expect(cell!.getAttribute('aria-label')).toContain('Fetch MDBList Ratings');
    });

    test('hovering a dot opens a bubble naming the step and explaining what it does', async () => {
        const user = userEvent.setup();
        render(PipelineProgressStrip, { rows: [makeRow('mdblist-sync')] });

        // Tooltip's trigger wrapper is what listens for mouseenter.
        const trigger = document.querySelector('.relative.inline-flex');
        expect(trigger).not.toBeNull();
        await user.hover(trigger as HTMLElement);

        // Body portal (`fixed`), so query the document rather than the container.
        await waitFor(() => {
            const bubble = document.querySelector('.tooltip-content');
            expect(bubble).not.toBeNull();
            expect(bubble!.textContent).toContain('Fetch MDBList Ratings');
            // …and the prose from pipelineStepDescription, not just the name.
            expect(bubble!.textContent).toContain('ratings, keywords');
        });
        // The prose body must be allowed to wrap — a nowrap sentence would
        // render as one viewport-wide strip.
        expect(
            document.querySelector('.tooltip-content')!.classList.contains('tooltip-content-wrap'),
        ).toBe(true);
    });
});
