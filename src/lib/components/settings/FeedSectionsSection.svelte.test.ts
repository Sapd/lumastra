// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const updateFeedPreferences = vi.fn(async (_body?: unknown) => ({ error: null }));
vi.mock('$lib/api/user', () => ({
    updateFeedPreferences: (body: unknown) => updateFeedPreferences(body),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));
// SavedCue fades with svelte/transition (element.animate), which happy-dom lacks.
vi.mock('./SavedCue.svelte', () => ({ default: vi.fn() }));

import FeedSectionsSection from './FeedSectionsSection.svelte';

describe('FeedSectionsSection', () => {
    afterEach(() => {
        cleanup();
        updateFeedPreferences.mockClear();
        vi.useRealTimers();
    });

    // This panel used to need its own Save button; a mode change that was
    // never saved was lost on leaving.
    test('saves a mode change on its own', async () => {
        vi.useFakeTimers();
        render(FeedSectionsSection, { feedMode: 'full' });
        await fireEvent.click(screen.getByRole('radio', { name: /Custom/ }));
        expect(updateFeedPreferences).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(updateFeedPreferences).toHaveBeenCalledWith(
            expect.objectContaining({ feedMode: 'custom' }),
        );
    });

    test('section switches only work in Custom mode', () => {
        render(FeedSectionsSection, { feedMode: 'full' });
        const sw = screen.getByRole('switch', { name: /Show Trending/ });
        expect((sw as HTMLButtonElement).disabled).toBe(true);
    });

    test('switching a section off in Custom mode saves it as hidden', async () => {
        vi.useFakeTimers();
        render(FeedSectionsSection, { feedMode: 'custom' });
        await fireEvent.click(screen.getByRole('switch', { name: /Show Trending/ }));
        await vi.advanceTimersByTimeAsync(1000);
        expect(updateFeedPreferences).toHaveBeenCalledWith(
            expect.objectContaining({ hiddenSectionKinds: ['trending'] }),
        );
    });
});
