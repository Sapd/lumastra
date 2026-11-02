// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import MediaIssueBadges from './MediaIssueBadges.svelte';

describe('collapsed media issue badges', () => {
    it('keeps hidden issue details described through first click and closes when focus leaves', async () => {
        const onselectview = vi.fn();
        render(MediaIssueBadges, {
            props: {
                mediaType: 'movie',
                max: 1,
                tooltipId: 'row-issues',
                onselectview,
                issues: [
                    { kind: 'no_tmdb', severity: 'warn' },
                    { kind: 'no_overview', severity: 'warn', detail: 'Synopsis missing upstream' },
                ],
            },
        });
        const more = screen.getByRole('button', { name: '+1' });

        expect(screen.queryByRole('tooltip')).toBeNull();
        more.focus();
        await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());

        expect(more.getAttribute('aria-describedby')).toBeTruthy();
        expect(screen.getByRole('tooltip').textContent).toContain('No overview');
        expect(screen.getByRole('tooltip').textContent).toContain('Synopsis missing upstream');
        await fireEvent.pointerDown(more);
        await fireEvent.click(more);

        expect(onselectview).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());

        more.blur();
        await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    });
});

it('gives a file finding a visible translated name and click target', async () => {
    const onselectview = vi.fn();
    render(MediaIssueBadges, {
        mediaType: 'movie',
        issues: [{ kind: 'file_problem', severity: 'error', subtype: 'integrity' }],
        onselectview,
    });
    await fireEvent.click(screen.getByRole('button', { name: /File problems|Integrity/i }));
    expect(onselectview).toHaveBeenCalledWith('files');
});
