// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SourceForm from './SourceForm.svelte';
import type { LiveTvSourceWithCount } from '$lib/schemas/livetv';
const api = vi.hoisted(() => ({
    createLiveTvSource: vi.fn(),
    updateLiveTvSource: vi.fn(),
    validateXtreamCredentialsApi: vi.fn(),
    validateHdHomeRunApi: vi.fn(),
}));
vi.mock('$lib/api/livetv', () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: toast }));
afterEach(cleanup);
beforeEach(() => {
    vi.clearAllMocks();
});
const source: LiveTvSourceWithCount = {
    id: 'source',
    name: 'Existing',
    sourceType: 'm3u',
    maxStreams: 1,
    channelCount: 5,
};
async function fill(id: string, value: string): Promise<void> {
    await fireEvent.input(document.querySelector(id)!, { target: { value } });
}
describe('Live TV setup form', () => {
    it('prefills the provider connection limit after testing credentials', async () => {
        api.validateXtreamCredentialsApi.mockResolvedValue({
            data: { valid: true, serverInfo: { maxConnections: 4 } },
        });
        render(SourceForm, { onSaved: vi.fn(), onCancel: vi.fn() });
        await fireEvent.click(screen.getByRole('button', { name: /Xtream/i }));
        await fill('#xtream-server', 'http://provider.example');
        await fill('#xtream-username', 'user');
        await fill('#xtream-password', 'pass');
        await fireEvent.click(screen.getByRole('button', { name: /Test Credentials/i }));
        await waitFor(() =>
            expect((document.querySelector('#max-streams') as HTMLInputElement).value).toBe('4'),
        );
    });
    it('redacts credentials in provider test messages', async () => {
        api.validateXtreamCredentialsApi.mockResolvedValue({
            data: {
                valid: true,
                serverInfo: { serverName: 'http://user:secret@provider.example' },
            },
        });
        render(SourceForm, { onSaved: vi.fn(), onCancel: vi.fn() });
        await fireEvent.click(screen.getByRole('button', { name: /Xtream/i }));
        await fill('#xtream-server', 'http://provider.example');
        await fill('#xtream-username', 'user');
        await fill('#xtream-password', 'pass');
        await fireEvent.click(screen.getByRole('button', { name: /Test Credentials/i }));
        const result = await screen.findByText(/Connected successfully/);
        expect(result.textContent).not.toContain('secret');
    });
    it('redacts credentials in a returned API error', async () => {
        api.updateLiveTvSource.mockResolvedValueOnce({
            data: null,
            error: 'Failed http://user:secret@provider.example/epg?password=secret',
        });
        const { container } = render(SourceForm, { source, onSaved: vi.fn(), onCancel: vi.fn() });
        await fireEvent.submit(container.querySelector('form')!);
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(JSON.stringify(toast.error.mock.calls)).not.toContain('secret');
    });
    it('leaves an unchosen create limit absent so the server can apply provider defaults', async () => {
        api.createLiveTvSource.mockResolvedValue({ data: { source } });
        const { container } = render(SourceForm, { onSaved: vi.fn(), onCancel: vi.fn() });
        await fireEvent.click(screen.getByRole('button', { name: /Xtream/i }));
        await fill('#source-name', 'Provider');
        await fill('#xtream-server', 'http://provider.example');
        await fill('#xtream-username', 'user');
        await fill('#xtream-password', 'pass');
        await fireEvent.submit(container.querySelector('form')!);
        await waitFor(() => expect(api.createLiveTvSource).toHaveBeenCalled());
        expect(api.createLiveTvSource.mock.calls[0][0].maxStreams).toBeUndefined();
    });
    it('forwards an edit run to the progress UI', async () => {
        api.updateLiveTvSource.mockResolvedValue({ data: { source, taskIds: { epg: 'run-epg' } } });
        const onSaved = vi.fn();
        const { container } = render(SourceForm, { source, onSaved, onCancel: vi.fn() });
        await fill('#xmltv-url', 'http://provider.example/epg');
        await fireEvent.submit(container.querySelector('form')!);
        await waitFor(() =>
            expect(onSaved).toHaveBeenCalledWith({ sourceId: 'source', runId: 'run-epg' }),
        );
    });
    it('shows the retry instruction when an import could not be queued', async () => {
        api.updateLiveTvSource.mockResolvedValue({
            data: { source, importError: 'Source saved; save again to retry.' },
        });
        const { container } = render(SourceForm, { source, onSaved: vi.fn(), onCancel: vi.fn() });
        await fireEvent.submit(container.querySelector('form')!);
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith('Source saved; save again to retry.'),
        );
        expect(toast.success).not.toHaveBeenCalled();
    });
    it('sends an edited HDHomeRun device address', async () => {
        api.updateLiveTvSource.mockResolvedValue({ data: { source } });
        const { container } = render(SourceForm, {
            source: { ...source, sourceType: 'hdhomerun' },
            onSaved: vi.fn(),
            onCancel: vi.fn(),
        });
        await fill('#hdhomerun-ip', '192.168.1.20');
        await fireEvent.submit(container.querySelector('form')!);
        await waitFor(() =>
            expect(api.updateLiveTvSource).toHaveBeenCalledWith(
                'source',
                expect.objectContaining({ hdHomeRunDeviceIp: '192.168.1.20' }),
            ),
        );
    });
    it('does not echo an exception containing source credentials', async () => {
        api.updateLiveTvSource.mockRejectedValueOnce(
            new Error('Request failed http://user:secret@provider.example/epg?password=secret'),
        );
        const { container } = render(SourceForm, { source, onSaved: vi.fn(), onCancel: vi.fn() });
        await fireEvent.submit(container.querySelector('form')!);
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(JSON.stringify(toast.error.mock.calls)).not.toContain('secret');
    });
    it.each(['m3u', 'xtream', 'hdhomerun'] as const)(
        'clears XMLTV explicitly for %s while leaving a blank edit URL untouched',
        async (sourceType) => {
            api.updateLiveTvSource.mockResolvedValue({ data: { source } });
            const { container } = render(SourceForm, {
                source: { ...source, sourceType },
                onSaved: vi.fn(),
                onCancel: vi.fn(),
            });
            await fireEvent.click(screen.getByRole('checkbox', { name: /Remove.*XMLTV/i }));
            await fireEvent.submit(container.querySelector('form')!);
            await waitFor(() =>
                expect(api.updateLiveTvSource).toHaveBeenCalledWith(
                    'source',
                    expect.objectContaining({ xmltvUrl: '' }),
                ),
            );
        },
    );
});
