// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgramDetailsPopover from './ProgramDetailsPopover.svelte';
import type { LiveTvAiring } from '$lib/schemas/livetv.js';

// Fixed local "now": 20:15 today.
const NOW = new Date(2026, 5, 10, 20, 15, 0);
const at = (h: number, min: number, dayOffset = 0): string =>
    new Date(2026, 5, 10 + dayOffset, h, min, 0).toISOString();

function airing(overrides: Partial<LiveTvAiring> = {}): LiveTvAiring {
    return {
        id: 'airing-1',
        stationId: 'station-1',
        title: 'Harbour Lights',
        description: 'A lighthouse keeper finds a message in a bottle.',
        startTime: at(19, 45),
        endTime: at(21, 15),
        genres: ['Drama', 'Mystery'],
        officialRating: '12',
        ...overrides,
    };
}

function renderPanel(program: LiveTvAiring) {
    const onWatchChannel = vi.fn();
    const onClose = vi.fn();
    render(ProgramDetailsPopover, {
        program,
        channelName: 'Orbit One',
        channelNumber: 7,
        channelCategory: 'Entertainment',
        onWatchChannel,
        onClose,
    });
    return { onWatchChannel, onClose };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('ProgramDetailsPopover', () => {
    it('shows channel, time slot, progress, description, genres and rating of a live airing', () => {
        renderPanel(airing());

        expect(screen.getByRole('heading', { level: 2, name: 'Harbour Lights' })).toBeTruthy();
        expect(screen.getByText('7 · Orbit One · Entertainment')).toBeTruthy();
        expect(screen.getByText(/Today · .* · 90 min/)).toBeTruthy();
        expect(screen.getByText('A lighthouse keeper finds a message in a bottle.')).toBeTruthy();
        expect(screen.getByLabelText('Age rating 12').textContent).toBe('12');

        const genres = screen.getByRole('list', { name: 'Genres' });
        expect(genres.textContent).toContain('Drama');
        expect(genres.textContent).toContain('Mystery');

        // 30 of 90 minutes have run.
        const progress = screen.getByRole('progressbar');
        expect(progress.getAttribute('aria-valuenow')).toBe('33');
        expect(screen.getByText('60 min left')).toBeTruthy();
    });

    it('tunes the channel from "Watch now" while the programme is live', async () => {
        const { onWatchChannel, onClose } = renderPanel(airing());

        await fireEvent.click(screen.getByRole('button', { name: /Watch now/ }));
        expect(onWatchChannel).toHaveBeenCalledOnce();

        await fireEvent.click(screen.getByRole('button', { name: 'Close program details' }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('is information only for an upcoming programme (no DVR)', () => {
        renderPanel(airing({ startTime: at(21, 15), endTime: at(22, 0) }));

        expect(screen.getByText('Starts in 60 min')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Watch now/ })).toBeNull();
        expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('says when a programme is already over', () => {
        renderPanel(airing({ startTime: at(18, 0), endTime: at(19, 0) }));

        expect(screen.getByText('Already over')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Watch now/ })).toBeNull();
    });

    it('labels tomorrow and omits empty optional fields', () => {
        renderPanel(
            airing({
                startTime: at(9, 0, 1),
                endTime: at(9, 30, 1),
                description: undefined,
                genres: [],
                officialRating: undefined,
            }),
        );

        expect(screen.getByText(/Tomorrow · .* · 30 min/)).toBeTruthy();
        expect(screen.queryByRole('list', { name: 'Genres' })).toBeNull();
        expect(screen.queryByLabelText(/Age rating/)).toBeNull();
    });

    it('moves from live to over while it stays open', async () => {
        renderPanel(airing({ endTime: at(20, 16) }));
        expect(screen.getByRole('button', { name: /Watch now/ })).toBeTruthy();

        await vi.advanceTimersByTimeAsync(90_000);

        expect(screen.getByText('Already over')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Watch now/ })).toBeNull();
    });
});
