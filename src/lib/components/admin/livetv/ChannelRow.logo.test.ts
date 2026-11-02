// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'vitest';
import type { AdminChannel } from '$lib/schemas/livetv.js';
import ChannelRow from './ChannelRow.svelte';
import { failedLogos } from '$lib/components/livetv/failed-logos.svelte.js';

const channel = (logoUrl: string): AdminChannel => ({
    id: 'c1',
    name: 'Station',
    sortOrder: 0,
    isVisible: true,
    images: { primary: { href: logoUrl, revision: '0', source: 'self' } },
});

describe('ChannelRow logo', () => {
    test('a logo that fails to load gives way to the fallback tile, and stays failed', async () => {
        const url = '/api/image/catalog/c1/poster?size=thumb&fallback=none';
        const first = render(ChannelRow, { channel: channel(url), mode: 'table' });
        const img = first.container.querySelector('img');
        expect(img?.getAttribute('src')).toBe(url);

        await fireEvent.error(img as HTMLImageElement);
        expect(first.container.querySelector('img')).toBeNull();
        expect(failedLogos.has(url)).toBe(true);

        // Another list rendering the same channel does not request the dead URL.
        const second = render(ChannelRow, { channel: channel(url), mode: 'card' });
        expect(second.container.querySelector('img')).toBeNull();
    });
});
