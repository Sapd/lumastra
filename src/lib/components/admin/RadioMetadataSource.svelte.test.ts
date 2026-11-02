// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The now-playing editor reports its state to the station form through
 * `onChange`; the form saves from that alone. These pin what it reports.
 */

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';

const apiPost = vi.fn();
vi.mock('$lib/api/client.js', () => ({
    apiPost: (...args: unknown[]) => apiPost(...args),
}));

import RadioMetadataSource from './RadioMetadataSource.svelte';
import type { RadioMetadataSourceChange } from './radio-metadata-source';

const STORED = {
    url: 'https://radio.example/now.json',
    format: 'json' as const,
    jsonPaths: { title: '$.title', artist: '$.artist' },
    timeoutMs: 3000,
    userAgent: 'Lumastra-Test',
};

function mount(value: typeof STORED | undefined) {
    const onChange = vi.fn<(change: RadioMetadataSourceChange) => void>();
    const view = render(RadioMetadataSource, {
        props: { streamUrl: 'https://radio.example/stream', value, onChange },
    });
    const last = (): RadioMetadataSourceChange => onChange.mock.calls.at(-1)![0];
    return { ...view, onChange, last };
}

async function typeUrl(container: HTMLElement, value: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('#radio-metadata-url')!;
    await fireEvent.input(input, { target: { value } });
    await tick();
}

describe('RadioMetadataSource onChange', () => {
    beforeEach(() => {
        apiPost.mockReset();
        apiPost.mockResolvedValue({ data: null, error: null });
    });
    afterEach(() => cleanup());

    it('reports a stored source unchanged, keeping timeoutMs and userAgent', async () => {
        const { last } = mount(STORED);
        await tick();
        expect(last()).toEqual({ source: STORED, valid: true, dirty: false });
    });

    it('an untouched incomplete stored source is invalid but not dirty', async () => {
        const { last } = mount({ ...STORED, jsonPaths: {} } as unknown as typeof STORED);
        await tick();
        expect(last()).toMatchObject({ source: null, valid: false, dirty: false });
    });

    it('a new URL without any mapped field is incomplete and shown as such', async () => {
        const { container, last } = mount(undefined);
        await tick();
        expect(last()).toEqual({ source: null, valid: true, dirty: false });

        await typeUrl(container, 'https://radio.example/now.json');
        expect(last()).toEqual({ source: null, valid: false, dirty: true });
        expect(container.querySelector('[data-radio-metadata-incomplete]')).not.toBeNull();
    });

    it('an empty regex pattern is incomplete', async () => {
        const { container, last } = mount(undefined);
        await typeUrl(container, 'https://radio.example/now.txt');
        const regex = container.querySelector<HTMLInputElement>('input[value="regex"]')!;
        await fireEvent.click(regex);
        await tick();
        expect(last()).toMatchObject({ valid: false, dirty: true });
    });

    it('clearing the URL of a stored source reports "no source", dirty', async () => {
        const { container, last } = mount(STORED);
        await typeUrl(container, '');
        expect(last()).toEqual({ source: null, valid: true, dirty: true });
    });

    it('drops a field set back to "(none)" from the saved paths', async () => {
        const { container, last } = mount(STORED);
        await tick();
        const selects = container.querySelectorAll<HTMLSelectElement>('select');
        const artist = selects[1];
        artist.selectedIndex = 0;
        await fireEvent.change(artist);
        await tick();
        expect(last().source?.jsonPaths).toEqual({ title: '$.title' });
        expect(last().dirty).toBe(true);
    });
});
