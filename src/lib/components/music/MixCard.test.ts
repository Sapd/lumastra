// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MixCard from './MixCard.svelte';

afterEach(cleanup);

describe('mix artwork and actions', () => {
    it.each([0, 1, 2, 3, 4])('fills the artwork using exactly %i available covers', (count) => {
        const covers = Array.from({ length: count }, (_, i) => `/cover-${i}.jpg`);
        const { container } = render(MixCard, {
            title: 'Night mix',
            covers,
            onopen: vi.fn(),
            onplay: vi.fn(),
        });
        const art = container.querySelector('.collage');
        expect(art?.getAttribute('data-cover-count')).toBe(String(count));
        expect(art?.querySelectorAll('img')).toHaveLength(count);
        expect(art?.children).toHaveLength(Math.max(1, count));
        expect(art?.querySelector('.cover-placeholder') !== null).toBe(count === 0);
    });

    it('keeps a server-composed collage as one full image', () => {
        const { container } = render(MixCard, {
            title: 'Library mix',
            covers: ['/composed-collage.jpg'],
            onopen: vi.fn(),
            onplay: vi.fn(),
        });
        expect(container.querySelector('.collage')?.getAttribute('data-cover-count')).toBe('1');
        expect(container.querySelector('img')?.getAttribute('src')).toBe('/composed-collage.jpg');
        expect(container.querySelector('.cover-placeholder')).toBeNull();
    });

    it('ignores empty URLs and uses at most four covers', () => {
        const { container } = render(MixCard, {
            title: 'Night mix',
            covers: ['', '/1', '/2', '/3', '/4', '/5'],
            onopen: vi.fn(),
            onplay: vi.fn(),
        });
        expect(container.querySelectorAll('img')).toHaveLength(4);
        expect(container.querySelector('img[src="/5"]')).toBeNull();
    });

    it('opens a preview and plays using distinct actions', async () => {
        const onopen = vi.fn();
        const onplay = vi.fn();
        render(MixCard, { title: 'Night mix', covers: [], onopen, onplay });
        await fireEvent.click(screen.getByRole('button', { name: 'Open Night mix' }));
        expect(onopen).toHaveBeenCalledOnce();
        expect(onplay).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('button', { name: 'Play Night mix' }));
        expect(onplay).toHaveBeenCalledOnce();
        expect(onopen).toHaveBeenCalledOnce();
    });
});
