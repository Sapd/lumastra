// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { EmbeddingSearch } from './useEmbeddingSearch.svelte';
import { searchMusicByText } from '$lib/api/music';
vi.mock('$lib/api/music', () => ({ searchMusicByText: vi.fn(), searchMusicByLyrics: vi.fn() }));
function deferred() {
    let resolve!: (value: Awaited<ReturnType<typeof searchMusicByText>>) => void;
    const promise = new Promise<Awaited<ReturnType<typeof searchMusicByText>>>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const success = {
    data: { items: [], page: { limit: 30, truncated: false } },
    error: null,
    status: 200,
};
it('ignores a late success from an older query', async () => {
    const old = deferred();
    vi.mocked(searchMusicByText).mockReturnValueOnce(old.promise).mockResolvedValueOnce(success);
    const state = new EmbeddingSearch(() => 'sonic');
    const pending = state.search('old');
    await state.search('new');
    old.resolve(success);
    await pending;
    expect(state.resolvedQuery).toBe('new');
});
it('does not let an older identical query stop the new spinner', async () => {
    const old = deferred();
    const current = deferred();
    vi.mocked(searchMusicByText)
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
    const state = new EmbeddingSearch(() => 'sonic');
    const a = state.search('piano');
    const b = state.search('piano');
    old.resolve(success);
    await a;
    expect(state.loading).toBe(true);
    current.resolve(success);
    await b;
    expect(state.loading).toBe(false);
});
it('reset prevents a late response from reopening cleared results', async () => {
    const old = deferred();
    vi.mocked(searchMusicByText).mockReturnValueOnce(old.promise);
    const state = new EmbeddingSearch(() => 'sonic');
    const pending = state.search('piano');
    state.reset();
    old.resolve(success);
    await pending;
    expect(state.resolvedQuery).toBe('');
    expect(state.fetchedForQuery).toBeNull();
});
it('shows a retryable error when a current request throws', async () => {
    vi.mocked(searchMusicByText).mockRejectedValueOnce(new Error('offline'));
    const state = new EmbeddingSearch(() => 'sonic');
    await state.search('piano');
    expect(state.errorMsg).toContain('try again');
    expect(state.loading).toBe(false);
});
