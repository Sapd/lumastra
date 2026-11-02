// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from '$app/state';
import ClusterEncoderCheck from './ClusterEncoderCheck.svelte';

const mocks = vi.hoisted(() => ({ metrics: vi.fn() }));
vi.mock('$app/state', async () => {
    const { SvelteURL } = await import('svelte/reactivity');
    return { page: { url: new SvelteURL('http://localhost/admin/system/health?tab=cluster') } };
});
vi.mock('$lib/api/admin.js', () => ({
    getSystemMetrics: mocks.metrics,
    getTranscodeCapabilities: vi.fn().mockResolvedValue({ data: null }),
    resetTranscodeDecodeCache: vi.fn(),
}));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => `/base${path}` }));
afterEach(cleanup);
beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    page.url.hash = '';
    mocks.metrics.mockReset();
    mocks.metrics.mockResolvedValue({
        data: {
            hostname: 'replica-a',
            gpu: { configured: 'none', detected: false, accessible: false },
        },
    });
});

describe('hardware diagnostic anchor', () => {
    it('stays collapsed without a hash and does not probe until opened', () => {
        render(ClusterEncoderCheck);
        expect((screen.getByTestId('cluster-encoder-check') as HTMLDetailsElement).open).toBe(
            false,
        );
        expect(mocks.metrics).not.toHaveBeenCalled();
    });
    it('opens and loads when directly linked', async () => {
        page.url.hash = '#hardware-encoder-check';
        render(ClusterEncoderCheck);
        await screen.findByTestId('cluster-encoder-check-replica');
        expect((screen.getByTestId('cluster-encoder-check') as HTMLDetailsElement).open).toBe(true);
        expect(mocks.metrics).toHaveBeenCalledTimes(1);
        expect(
            screen
                .getByRole('link', { name: 'Configure hardware acceleration' })
                .getAttribute('href'),
        ).toBe('/base/admin/settings/playback?category=ffmpeg-hardware');
    });
    it('opens after client navigation to the anchor and permits retry on failure', async () => {
        mocks.metrics.mockResolvedValueOnce({ error: 'offline' });
        render(ClusterEncoderCheck);
        page.url.hash = '#hardware-encoder-check';
        await waitFor(() => expect(mocks.metrics).toHaveBeenCalledTimes(1));
        await screen.findByRole('button', { name: 'Test saved encoder' });
        await fireEvent.click(screen.getByRole('button', { name: 'Test saved encoder' }));
        await screen.findByTestId('cluster-encoder-check-replica');
        expect(mocks.metrics).toHaveBeenCalledTimes(2);
    });
});
