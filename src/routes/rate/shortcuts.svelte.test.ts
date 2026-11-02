// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import RatePage from './+page.svelte';
import * as m from '$lib/paraglide/messages';
import { openMediaModal } from '$lib/utils/modal-utils';
import { toasts } from '$lib/stores/toast.store';

const api = vi.hoisted(() => ({
    getUserStats: vi.fn(),
    getRateQueue: vi.fn(),
    submitRating: vi.fn(),
    clearRating: vi.fn(),
    skipRateItems: vi.fn(),
}));
vi.mock('$lib/api/ai', () => api);
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/stores/modal.store', () => ({ hasModals: readable(false) }));
vi.mock('$lib/utils/modal-utils', () => ({ openMediaModal: vi.fn() }));
vi.mock('$lib/utils/image-utils', () => ({ imageFromIds: () => '' }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn() } }));

beforeEach(() => {
    localStorage.setItem('rateTrainer.coachSeen', 'true');
    api.getUserStats.mockResolvedValue({
        data: { stats: { totalRatings: 0 } },
        error: null,
        status: 200,
    });
    api.getRateQueue.mockResolvedValue({
        data: {
            status: 'exhausted',
            page: { limit: 20, hasMore: false, nextCursor: 'session' },
            items: [
                { externalIds: { tmdb: '1' }, mediaType: 'movie', title: 'First candidate' },
                { externalIds: { tmdb: '2' }, mediaType: 'movie', title: 'Second candidate' },
            ],
        },
        error: null,
        status: 200,
    });
    api.submitRating.mockResolvedValue({ data: { totalRatings: 1 }, error: null, status: 200 });
    api.clearRating.mockResolvedValue({ data: { totalRatings: 0 }, error: null, status: 200 });
});
afterEach(() => {
    vi.useRealTimers();
    cleanup();
    localStorage.removeItem('rateTrainer.coachSeen');
    vi.resetAllMocks();
});

test('first visit offers optional help and immediately usable ratings', async () => {
    localStorage.removeItem('rateTrainer.coachSeen');
    const view = render(RatePage);
    await view.findByText('First candidate');
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByText(m.rate_help_toggle())).toBeTruthy();
    expect(view.getByTestId('session-count').textContent).toBe(
        m.rate_session_count({ count: '0' }),
    );
    const help = view.getByText(m.rate_help_toggle());
    await fireEvent.click(help);
    help.focus();
    await fireEvent.keyDown(help, { key: ' ', code: 'Space' });
    await fireEvent.keyDown(help, { key: 'm', code: 'KeyM' });
    expect(api.submitRating).not.toHaveBeenCalled();
    help.blur();
    await fireEvent.click(view.getByRole('button', { name: m.rating_meh() }));
    await waitFor(() => expect(api.submitRating).toHaveBeenCalledOnce());
});

test('focused controls and already-handled keys do not rate the card', async () => {
    const view = render(RatePage);
    await view.findByText('First candidate');
    const back = view.getByRole('link', { name: new RegExp(m.rate_trainer_back()) });
    back.focus();
    await fireEvent.keyDown(back, { key: 'm', code: 'KeyM' });
    await fireEvent.keyDown(back, { key: ' ', code: 'Space' });
    const filter = view.getByRole('button', { name: m.rate_filter_seen() });
    filter.focus();
    await fireEvent.keyDown(filter, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(api.submitRating).not.toHaveBeenCalled();
    filter.blur();
    const handled = new KeyboardEvent('keydown', {
        key: 'm',
        code: 'KeyM',
        bubbles: true,
        cancelable: true,
    });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(api.submitRating).not.toHaveBeenCalled();
    await fireEvent.keyDown(document.body, { key: 'm', code: 'KeyM' });
    await waitFor(() => expect(api.submitRating).toHaveBeenCalledOnce());
});

test('saved title and exact score remain recoverable and keyboard Undo restores the final card', async () => {
    api.getRateQueue.mockResolvedValue({
        data: {
            status: 'exhausted',
            page: { limit: 1, hasMore: false },
            items: [{ externalIds: { tmdb: '1' }, mediaType: 'series', title: 'Final candidate' }],
        },
        error: null,
        status: 200,
    });
    const view = render(RatePage);
    await view.findByRole('heading', { name: 'Final candidate' });
    const liveRegion = view.getByRole('status');
    expect(liveRegion.textContent?.trim()).toBe('');
    expect(view.getByText(m.hero_media_type_series())).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: m.rate_show_stars() }));
    await fireEvent.keyDown(document.body, { key: '7', code: 'Digit7' });
    await waitFor(() =>
        expect(api.submitRating).toHaveBeenCalledWith({ tmdb: '1' }, 'series', 7, 'rate-trainer', {
            ratingStyle: 'stars',
        }),
    );
    await view.findByText(m.rate_exhausted_title());
    expect(view.getByRole('status')).toBe(liveRegion);
    expect(view.getByRole('status').textContent).toContain(
        m.rate_saved_confirmation({ title: 'Final candidate', rating: '7' }),
    );
    expect(view.getByTestId('session-count').textContent).toBe(
        m.rate_session_count({ count: '1' }),
    );
    expect(view.getByRole('button', { name: m.rate_undo() })).toBeTruthy();
    await fireEvent.keyDown(document.body, { key: 'u', code: 'KeyU' });
    await view.findByRole('heading', { name: 'Final candidate' });
    expect(api.clearRating).toHaveBeenCalledOnce();
    expect(view.getByRole('status').textContent?.trim()).toBe('');
    expect(view.getByTestId('session-count').textContent).toBe(
        m.rate_session_count({ count: '0' }),
    );
});

test('failed saves keep the card and failed Undo keeps confirmation recoverable', async () => {
    const view = render(RatePage);
    await view.findByText('First candidate');
    api.submitRating.mockResolvedValueOnce({ data: null, error: 'failed', status: 500 });
    await fireEvent.click(view.getByRole('button', { name: m.rating_meh() }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(m.ai_rate_save_failed()));
    expect(view.getByRole('heading', { name: 'First candidate' })).toBeTruthy();
    expect(view.getByRole('status').textContent?.trim()).toBe('');
    expect(view.getByTestId('session-count').textContent).toBe(
        m.rate_session_count({ count: '0' }),
    );
    await fireEvent.click(view.getByRole('button', { name: m.rating_meh() }));
    await waitFor(() => expect(view.getByRole('status').textContent).toContain('First candidate'));
    api.clearRating.mockResolvedValueOnce({ data: null, error: 'failed', status: 500 });
    const undo = view.getByRole('button', { name: m.rate_undo() });
    undo.focus();
    await fireEvent.click(undo);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(m.rate_undo_failed()));
    expect(document.activeElement).toBe(undo);
    expect(view.getByRole('status').textContent).toContain('First candidate');
    expect(view.getByRole('button', { name: m.rate_undo() })).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: m.rate_undo() }));
    await view.findByRole('heading', { name: 'First candidate' });
});

test('missing metadata shows a type and one details action without a duplicate overview toggle', async () => {
    const view = render(RatePage);
    await view.findByText('First candidate');
    expect(view.getAllByText(m.hero_media_type_movie())).toHaveLength(2);
    const details = view.getAllByRole('button', { name: m.rate_view_details() });
    expect(details).toHaveLength(1); // Rear cards are hidden from assistive technology and inert.
    expect(view.queryByRole('button', { name: m.rate_overview_more() })).toBeNull();
    await fireEvent.click(details[0]);
    expect(openMediaModal).toHaveBeenCalledOnce();
    expect(api.submitRating).not.toHaveBeenCalled();
});

test('successful button Undo respects focus moved elsewhere while the clear is pending', async () => {
    const view = render(RatePage);
    await view.findByRole('heading', { name: 'First candidate' });
    await fireEvent.click(view.getByRole('button', { name: m.rating_meh() }));
    await waitFor(() => expect(view.getByRole('status').textContent).toContain('First candidate'));
    let finishClear:
        | ((value: { data: { totalRatings: number }; error: null; status: number }) => void)
        | undefined;
    api.clearRating.mockReturnValueOnce(
        new Promise((resolve) => {
            finishClear = resolve;
        }),
    );
    const undo = view.getByRole('button', { name: m.rate_undo() });
    undo.focus();
    await fireEvent.click(undo);
    const back = view.getByRole('link', { name: new RegExp(m.rate_trainer_back()) });
    back.focus();
    finishClear?.({ data: { totalRatings: 0 }, error: null, status: 200 });
    await waitFor(() => expect(view.getByRole('status').textContent?.trim()).toBe(''));
    expect(document.activeElement).toBe(back);
});

test('a delayed save does not scroll away from newly focused help', async () => {
    const view = render(RatePage);
    await view.findByText('First candidate');
    let finishSave:
        | ((value: { data: { totalRatings: number }; error: null; status: number }) => void)
        | undefined;
    api.submitRating.mockReturnValueOnce(
        new Promise((resolve) => {
            finishSave = resolve;
        }),
    );
    const confirmation = view.getByRole('status').parentElement!;
    const scroll = vi.fn();
    confirmation.scrollIntoView = scroll;
    await fireEvent.click(view.getByRole('button', { name: m.rating_meh() }));
    view.getByText(m.rate_help_toggle()).focus();
    finishSave?.({ data: { totalRatings: 1 }, error: null, status: 200 });
    await waitFor(() => expect(view.getByRole('status').textContent).toContain('First candidate'));
    expect(scroll).not.toHaveBeenCalled();
});
