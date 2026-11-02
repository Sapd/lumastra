// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { tick } from 'svelte';
import type { PageData } from './$types';

const api = vi.hoisted(() => ({
    initUploadSession: vi.fn(),
    finalizeUploadSession: vi.fn(),
    abortUploadSession: vi.fn(),
    uploadAncillaryFile: vi.fn(),
}));
const targets = vi.hoisted(() => vi.fn());
const run = vi.hoisted(() => vi.fn());
const network = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin.js', () => api);
vi.mock('$lib/api/upload-attachment-targets.js', () => ({ getUploadAttachmentTargets: targets }));
vi.mock('$lib/api/client.js', () => ({ apiGet: run }));
vi.mock('$lib/auth-monitor.js', () => ({ monitoredFetch: network }));
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));
vi.mock('$lib/components/admin', () => ({ AdminPageHeader: () => undefined }));
import Page from './+page.svelte';

const library = '00000000-0000-4000-8000-000000000001';
const upload = '00000000-0000-4000-8000-000000000002';
const first = '00000000-0000-4000-8000-000000000003';
const second = '00000000-0000-4000-8000-000000000004';
beforeEach(() => {
    vi.clearAllMocks();
    api.initUploadSession.mockResolvedValue({
        data: { uploadId: upload, chunkSize: 8, expiresAt: '2026-10-29T00:00:00Z' },
    });
    api.finalizeUploadSession.mockResolvedValue({
        data: { path: '/uploads/Lantern Film.mp4', runId: 'ingest-run', status: 'queued' },
    });
    api.uploadAncillaryFile.mockResolvedValue({
        data: { path: '/uploads/Lantern Film.en.srt', type: 'subtitle' },
    });
    network.mockResolvedValue(
        new Response(JSON.stringify({ received: true, chunkIndex: 0, chunksReceived: 1 }), {
            status: 200,
        }),
    );
    run.mockResolvedValue({
        data: {
            id: 'ingest-run',
            taskId: 'file-delta-ingest',
            state: 'completed',
            result: { success: true },
        },
    });
    targets.mockResolvedValue({
        data: { status: 'ready', targetId: first, targets: [{ id: first, title: 'Lantern Film' }] },
    });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

async function uploadPrimary(): Promise<void> {
    render(Page, {
        data: {
            libraryPaths: [{ id: library, path: '/uploads', media_type: 'home_video' }],
        } as PageData,
    });
    await tick();
    const librarySelect = screen.getByLabelText('Library path') as HTMLSelectElement;
    librarySelect.selectedIndex = 1;
    expect(librarySelect.value).toBe(library);
    await fireEvent.change(librarySelect);
    const input = await waitFor(() => {
        const input = document.querySelector<HTMLInputElement>('input[type=file]');
        expect(input).toBeTruthy();
        return input!;
    });
    Object.defineProperty(input, 'files', {
        value: [new File([new Uint8Array(4)], 'Lantern Film.mp4', { type: 'video/mp4' })],
        configurable: true,
    });
    await fireEvent.change(input);
    await fireEvent.click(screen.getByRole('button', { name: 'Start upload' }));
}

it('attaches to the exact ingest result without asking for a UUID', async () => {
    await uploadPrimary();
    await screen.findByText('Attach files to: Lantern Film');
    expect(document.getElementById('ancillary-item-id')).toBeNull();
    expect(targets).toHaveBeenCalledWith(library, upload);
    const subtitle = new File(['1\n00:00:01,000 --> 00:00:02,000\nA lantern\n'], 'en.srt', {
        type: 'application/x-subrip',
    });
    const input = document.getElementById('ancillary-file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [subtitle], configurable: true });
    await fireEvent.change(input);
    await fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() =>
        expect(api.uploadAncillaryFile).toHaveBeenCalledExactlyOnceWith(
            library,
            first,
            subtitle,
            'subtitle',
            upload,
        ),
    );
});

it('waits for ingest completion and leaves an ambiguous target as an explicit title choice', async () => {
    run.mockResolvedValueOnce({
        data: { id: 'ingest-run', taskId: 'file-delta-ingest', state: 'active' },
    });
    targets.mockResolvedValue({
        data: {
            status: 'ambiguous',
            targets: [
                { id: first, title: 'Arrival' },
                { id: second, title: 'Departure' },
            ],
        },
    });
    await uploadPrimary();
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(targets).not.toHaveBeenCalled();
    expect(document.getElementById('ancillary-file')).toBeNull();
    const picker = (await screen.findByLabelText(
        'Choose which imported title gets the attachment',
        {},
        { timeout: 5000 },
    )) as HTMLSelectElement;
    expect(picker.value).toBe('');
    expect(document.getElementById('ancillary-file')).toBeNull();
    picker.selectedIndex = 2;
    expect(picker.value).toBe(second);
    await fireEvent.change(picker);
    expect(document.getElementById('ancillary-file')).toBeTruthy();
    expect(api.finalizeUploadSession).toHaveBeenCalledOnce();
});

it('preserves an explicit target when the same upload has several bound titles', async () => {
    targets.mockResolvedValue({
        data: {
            status: 'ready',
            targetId: second,
            targets: [
                { id: first, title: 'Arrival' },
                { id: second, title: 'Departure' },
            ],
        },
    });
    await uploadPrimary();
    const picker = (await screen.findByLabelText(
        'Choose which imported title gets the attachment',
    )) as HTMLSelectElement;
    expect(picker.value).toBe(second);
    expect(document.getElementById('ancillary-file')).toBeTruthy();
});

it('requires an explicit choice when the requested session target is absent even with one linked title', async () => {
    targets.mockResolvedValue({
        data: { status: 'ambiguous', targets: [{ id: first, title: 'Lantern Arrival' }] },
    });
    await uploadPrimary();
    const picker = (await screen.findByLabelText(
        'Choose which imported title gets the attachment',
    )) as HTMLSelectElement;
    expect(picker.value).toBe('');
    expect(document.getElementById('ancillary-file')).toBeNull();
    picker.selectedIndex = 1;
    await fireEvent.change(picker);
    expect(document.getElementById('ancillary-file')).toBeTruthy();
});
