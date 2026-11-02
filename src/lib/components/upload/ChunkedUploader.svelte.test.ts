// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The uploader drives a server session through init → chunk PUTs → finalize.
 * These tests pin the client side of that contract: the chunk layout comes
 * from the server, Cancel really stops the upload and drops the session, a
 * transient chunk failure is retried, and success/failure are reported as
 * what actually happened.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    initUploadSession: vi.fn(),
    finalizeUploadSession: vi.fn(),
    abortUploadSession: vi.fn(),
}));
const net = vi.hoisted(() => ({ monitoredFetch: vi.fn() }));

vi.mock('$lib/api/admin.js', () => api);
vi.mock('$lib/auth-monitor.js', () => net);
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));

import ChunkedUploader from './ChunkedUploader.svelte';

const LIB = 'lib-1';
const UPLOAD = '11111111-1111-4111-8111-111111111111';

function chunkOk(index: number): Response {
    return new Response(JSON.stringify({ received: true, chunkIndex: index, chunksReceived: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function chunkIndexOf(url: string): number {
    return Number(url.split('/').pop());
}

async function pick(file: File): Promise<void> {
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await fireEvent.change(input);
}

function videoOfSize(bytes: number): File {
    return new File([new Uint8Array(bytes)], 'clip.mp4', { type: 'video/mp4' });
}

beforeEach(() => {
    api.initUploadSession.mockResolvedValue({
        data: { uploadId: UPLOAD, chunkSize: 4, expiresAt: '2026-10-07T00:00:00.000Z' },
        error: null,
        status: 201,
    });
    api.finalizeUploadSession.mockResolvedValue({
        data: { path: '/lib/clip.mp4', runId: 'run-1', status: 'queued' },
        error: null,
        status: 200,
    });
    api.abortUploadSession.mockResolvedValue({ data: { aborted: true }, error: null, status: 200 });
    net.monitoredFetch.mockImplementation(async (url: string) => chunkOk(chunkIndexOf(url)));
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe('ChunkedUploader', () => {
    it('slices by the server chunk size and finalizes with the matching count', async () => {
        const onComplete = vi.fn();
        render(ChunkedUploader, { props: { libraryPathId: LIB, onComplete } });
        await pick(videoOfSize(10)); // 4 + 4 + 2 bytes
        await fireEvent.click(screen.getByRole('button', { name: 'Start upload' }));

        await waitFor(() => expect(onComplete).toHaveBeenCalled());
        const indexes = net.monitoredFetch.mock.calls.map(([url]) => chunkIndexOf(url as string));
        expect(indexes).toEqual([0, 1, 2]);
        expect(api.finalizeUploadSession).toHaveBeenCalledWith(
            LIB,
            UPLOAD,
            { totalChunks: 3 },
            expect.objectContaining({ timeout: expect.any(Number) }),
        );
        expect(onComplete).toHaveBeenCalledWith(
            expect.objectContaining({ path: '/lib/clip.mp4', queued: true }),
        );
        expect(screen.getByText('Upload complete')).toBeTruthy();
    });

    it('Cancel stops the chunk loop, drops the session and stays cancelled', async () => {
        const onError = vi.fn();
        let releaseFirst!: () => void;
        net.monitoredFetch.mockImplementationOnce(
            (url: string, init: RequestInit) =>
                new Promise<Response>((resolve, reject) => {
                    releaseFirst = () => resolve(chunkOk(chunkIndexOf(url)));
                    init.signal?.addEventListener('abort', () =>
                        reject(new DOMException('aborted', 'AbortError')),
                    );
                }),
        );
        render(ChunkedUploader, { props: { libraryPathId: LIB, onError } });
        await pick(videoOfSize(10));
        await fireEvent.click(screen.getByRole('button', { name: 'Start upload' }));
        await waitFor(() => expect(net.monitoredFetch).toHaveBeenCalledTimes(1));

        await fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
        releaseFirst();
        await new Promise((r) => setTimeout(r, 20));

        expect(net.monitoredFetch).toHaveBeenCalledTimes(1);
        expect(api.finalizeUploadSession).not.toHaveBeenCalled();
        expect(api.abortUploadSession).toHaveBeenCalledWith(LIB, UPLOAD);
        expect(onError).not.toHaveBeenCalled();
        expect(screen.getByText('Upload cancelled.')).toBeTruthy();
    });

    it('Cancel during init drops the session the server creates afterwards', async () => {
        let resolveInit!: (v: unknown) => void;
        api.initUploadSession.mockImplementationOnce(
            () => new Promise((resolve) => (resolveInit = resolve)),
        );
        render(ChunkedUploader, { props: { libraryPathId: LIB } });
        await pick(videoOfSize(10));
        await fireEvent.click(screen.getByRole('button', { name: 'Start upload' }));
        await fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));

        resolveInit({
            data: { uploadId: UPLOAD, chunkSize: 4, expiresAt: '2026-10-07T00:00:00.000Z' },
            error: null,
            status: 201,
        });
        await new Promise((r) => setTimeout(r, 20));

        expect(net.monitoredFetch).not.toHaveBeenCalled();
        expect(api.abortUploadSession).toHaveBeenCalledWith(LIB, UPLOAD);
        expect(screen.getByText('Upload cancelled.')).toBeTruthy();
    });

    it('retries a chunk after a transient 503 and completes', async () => {
        const onComplete = vi.fn();
        net.monitoredFetch.mockResolvedValueOnce(new Response('busy', { status: 503 }));
        render(ChunkedUploader, { props: { libraryPathId: LIB, onComplete } });
        await pick(videoOfSize(3));
        await fireEvent.click(screen.getByRole('button', { name: 'Start upload' }));

        await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 3000 });
        expect(net.monitoredFetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 4xx; reports it and releases the session', async () => {
        const onError = vi.fn();
        net.monitoredFetch.mockResolvedValue(
            new Response(JSON.stringify({ detail: 'Chunk 0 has 3 bytes, expected 4' }), {
                status: 422,
                headers: { 'content-type': 'application/problem+json' },
            }),
        );
        render(ChunkedUploader, { props: { libraryPathId: LIB, onError } });
        await pick(videoOfSize(3));
        await fireEvent.click(screen.getByRole('button', { name: 'Start upload' }));

        await waitFor(() => expect(onError).toHaveBeenCalled());
        expect(net.monitoredFetch).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('alert').textContent).toContain('expected 4');
        expect(api.abortUploadSession).toHaveBeenCalledWith(LIB, UPLOAD);
    });

    it('says so when the file was saved but ingest was not queued', async () => {
        api.finalizeUploadSession.mockResolvedValue({
            data: { path: '/lib/clip.mp4', status: 'skipped' },
            error: null,
            status: 200,
        });
        render(ChunkedUploader, { props: { libraryPathId: LIB } });
        await pick(videoOfSize(3));
        await fireEvent.click(screen.getByRole('button', { name: 'Start upload' }));

        await screen.findByText('Upload complete');
        expect(screen.getByText(/ingest could not be started/)).toBeTruthy();
    });

    it('a rejected pick clears the earlier valid file', async () => {
        render(ChunkedUploader, { props: { libraryPathId: LIB } });
        await pick(videoOfSize(3));
        expect(screen.getByRole('button', { name: 'Start upload' })).toBeTruthy();
        await pick(new File(['x'], 'notes.txt', { type: 'text/plain' }));
        expect(screen.queryByRole('button', { name: 'Start upload' })).toBeNull();
        expect(screen.getByRole('alert').textContent).toContain('.txt');
    });
});
