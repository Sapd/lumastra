// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import Embeddings from './+page.svelte';
const api = vi.hoisted(() => ({ video: vi.fn(), music: vi.fn() }));
vi.mock('$lib/api/ai', () => ({
    getEmbeddingStats: vi.fn().mockResolvedValue({ data: null }),
    getVideoEmbeddingStats: api.video,
    getMusicEmbeddingStats: api.music,
    getEmbeddingPreviews: vi.fn().mockResolvedValue({ data: null }),
    getEmbeddingText: vi.fn(),
}));
vi.mock('$lib/components/admin', async () => {
    const Empty = (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default;
    return {
        AdminPageHeader: Empty,
        DataQualityMetric: Empty,
        EmbeddingSearchWidget: Empty,
        EmbeddingLookupWidget: Empty,
    };
});
vi.mock('$lib/components/ui', async () => ({
    Tabs: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
afterEach(cleanup);
it('stops automatic retries after a failed statistics request', async () => {
    api.video.mockResolvedValue({ error: 'Service unavailable' });
    render(Embeddings);
    await waitFor(() => expect(api.video).toHaveBeenCalledOnce());
    await tick();
    await tick();
    expect(api.video).toHaveBeenCalledOnce();
});
