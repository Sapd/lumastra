// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProgramGuide from './ProgramGuide.svelte';
import { fetchGuidePrograms } from '$lib/api/livetv-playback.js';

vi.mock('$lib/api/livetv-playback.js', () => ({ fetchGuidePrograms: vi.fn() }));
afterEach(cleanup);
beforeEach(() => {
    vi.mocked(fetchGuidePrograms)
        .mockReset()
        .mockResolvedValue({
            status: 200,
            data: {
            stations: [],
            window: { from: '', to: '', asOf: '' },
            page: { limit: 200, nextCursor: null, hasMore: false },
        },
            error: null,
        });
});

const channels = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        feedId: `c${i}`,
        name: `C${i}`,
        images: {},
        isVisible: true,
        nowNext: { current: null, next: null },
        sortOrder: i,
    }));

it('asks a scoped guide for at most 200 of its channels', async () => {
    render(ProgramGuide, { props: { channels: channels(250), categories: [], scoped: true } });
    await tick();
    await tick();
    const ids = vi.mocked(fetchGuidePrograms).mock.calls[0][2];
    expect(ids).toHaveLength(200);
    expect(ids?.[0]).toBe('c0');
});

it('does not fetch the whole guide for a scoped guide without channels', async () => {
    render(ProgramGuide, { props: { channels: [], categories: [], scoped: true } });
    await tick();
    await tick();
    expect(fetchGuidePrograms).not.toHaveBeenCalled();
});

it('fetches the whole guide when not scoped', async () => {
    render(ProgramGuide, { props: { channels: channels(3), categories: [] } });
    await tick();
    await tick();
    expect(vi.mocked(fetchGuidePrograms).mock.calls[0][2]).toBeUndefined();
});

it('shows only the part after a shared prefix in the name column', async () => {
    const { container } = render(ProgramGuide, {
        props: {
            channels: [
                {
                    id: 'a',
                    feedId: 'a',
                    name: 'ZAVO EVENT GRD 1',
                    images: {},
                    isVisible: true,
                    nowNext: { current: null, next: null },
                    sortOrder: 0,
                },
                {
                    id: 'b',
                    feedId: 'b',
                    name: 'ZAVO EVENT GRD | 2 - Otters vs Herons',
                    images: {},
                    isVisible: true,
                    nowNext: { current: null, next: null },
                    sortOrder: 1,
                },
            ],
            categories: [],
            scoped: true,
            sharedPrefix: 'ZAVO EVENT GRD',
        },
    });
    await tick();
    const labels = [...container.querySelectorAll('button[title] span')].map((s) =>
        s.textContent?.trim(),
    );
    expect(labels).toEqual(['1', '2 - Otters vs Herons']);
});

it('strips the shared prefix only at a word boundary', async () => {
    const { container } = render(ProgramGuide, {
        props: {
            channels: [
                {
                    id: 'a',
                    feedId: 'a',
                    name: 'Orb Sports News',
                    images: {},
                    isVisible: true,
                    nowNext: { current: null, next: null },
                    sortOrder: 0,
                },
            ],
            categories: [],
            scoped: true,
            sharedPrefix: 'Orb Sport',
        },
    });
    await tick();
    const label = container
        .querySelector('button[aria-label="Orb Sports News"] span')
        ?.textContent?.trim();
    expect(label).toBe('Orb Sports News');
});
