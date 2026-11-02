// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

vi.mock('$app/stores', () => ({ page: writable({ data: {} }) }));
vi.mock('$lib/utils/modal-utils', () => ({ openMediaModal: vi.fn() }));
vi.mock('$lib/utils/image-utils', () => ({ imageFromIds: vi.fn(() => '') }));
vi.mock('$lib/components/sections', async () => ({
    SectionRenderer: (await import('../__fixtures__/MediaCarouselItems.svelte')).default,
}));

import { openMediaModal } from '$lib/utils/modal-utils';
import MediaCarousel from './MediaCarousel.svelte';

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('statistics MediaCarousel availability', () => {
    it.each([
        [{ id: 'catalog-uuid' }, false],
        [{ id: 'catalog-uuid', isAvailable: false }, false],
        [{ id: 'catalog-uuid', isAvailable: true }, true],
    ])(
        'preserves availability for stats input %j and keeps details clickable',
        async (row, available) => {
            render(MediaCarousel, {
                type: 'movies',
                items: [{ ...row, title: 'Sample', externalIds: { internal: 'catalog-uuid' } }],
            });

            expect(screen.getByTestId('stats-Sample').textContent).toContain(String(available));
            await fireEvent.click(screen.getByTestId('stats-Sample'));
            expect(openMediaModal).toHaveBeenCalledWith(
                expect.objectContaining({ isAvailable: available }),
                expect.any(String),
            );
        },
    );
});
