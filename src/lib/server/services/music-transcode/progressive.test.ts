// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    expectedMp3Size,
    ProgressiveReaders,
    PROGRESSIVE_READER_GRACE_MS,
    tailFile,
} from './progressive.js';

const directories: string[] = [];
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function fixture(): Promise<{ partialPath: string; finalPath: string }> {
    const path = await mkdtemp(join(tmpdir(), 'moon-river-tail-'));
    directories.push(path);
    return { partialPath: join(path, 'audio.partial'), finalPath: join(path, 'audio.mp3') };
}

async function text(body: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(body).text();
}

describe('expectedMp3Size', () => {
    it('uses duration times CBR bitrate, rounded up to whole bytes', () => {
        expect(expectedMp3Size(600, 128)).toBe(9_600_000);
        expect(expectedMp3Size(0.0001, 128)).toBe(2);
        expect(expectedMp3Size(4800, 192)).toBe(115_200_000);
    });
    it('rejects implausible durations using source size and bitrate', () => {
        expect(expectedMp3Size(6 * 3600, 128)).toBeNull();
        expect(expectedMp3Size(600, 128, 100)).toBeNull();
        expect(expectedMp3Size(1, 128, 10_000_000)).toBeNull();
        expect(expectedMp3Size(600, 128, 2_400_000, 320_000)).toBeNull();
        expect(expectedMp3Size(600, 128, 24_000_000, 320_000)).toBe(9_600_000);
    });
    it.each([undefined, 0, -1, NaN, Infinity, Number.MAX_VALUE])(
        'rejects invalid duration %s',
        (duration) => {
            expect(expectedMp3Size(duration, 128)).toBeNull();
        },
    );
});

describe('tailFile', () => {
    it('reads growth in steps and stops at the requested end before completion', async () => {
        const paths = await fixture();
        await writeFile(paths.partialPath, 'ab');
        const closed = vi.fn();
        const reader = tailFile({
            ...paths,
            start: 1,
            end: 4,
            expectedSize: 10,
            completion: new Promise<void>(() => {}),
            pollMs: 2,
            onClose: closed,
        }).getReader();
        expect(Buffer.from((await reader.read()).value!).toString()).toBe('b');
        const pending = reader.read();
        await appendFile(paths.partialPath, 'cdefgh');
        expect(Buffer.from((await pending).value!).toString()).toBe('cde');
        expect((await reader.read()).done).toBe(true);
        await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    });
    it('survives rename and waits for successful completion before the final byte', async () => {
        const paths = await fixture();
        await writeFile(paths.partialPath, 'abc');
        let finish!: () => void;
        const completion = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const reader = tailFile({
            ...paths,
            start: 0,
            end: 2,
            expectedSize: 3,
            completion,
            pollMs: 2,
        }).getReader();
        expect(Buffer.from((await reader.read()).value!).toString()).toBe('ab');
        await rename(paths.partialPath, paths.finalPath);
        finish();
        expect(Buffer.from((await reader.read()).value!).toString()).toBe('c');
        expect((await reader.read()).done).toBe(true);
    });
    it('errors on encoder failure even while waiting for growth', async () => {
        const paths = await fixture();
        let fail!: (error: Error) => void;
        const completion = new Promise<void>((_, reject) => {
            fail = reject;
        });
        const body = text(tailFile({ ...paths, start: 0, end: 4, expectedSize: 5, completion }));
        const assertion = expect(body).rejects.toThrow('encoder failed');
        fail(new Error('encoder failed'));
        await assertion;
    });
    it('times out waiting for bytes', async () => {
        const paths = await fixture();
        await writeFile(paths.partialPath, '');
        await expect(
            text(
                tailFile({
                    ...paths,
                    start: 0,
                    end: 3,
                    expectedSize: 4,
                    completion: new Promise<void>(() => {}),
                    timeoutMs: 10,
                    pollMs: 2,
                }),
            ),
        ).rejects.toThrow('Timed out');
    });
    it('closes an open reader on abort and on body cancellation', async () => {
        for (const abort of [true, false]) {
            const paths = await fixture();
            await writeFile(paths.partialPath, 'abc');
            const controller = new AbortController();
            const closed = vi.fn();
            const reader = tailFile({
                ...paths,
                start: 0,
                end: 8,
                expectedSize: 9,
                completion: new Promise<void>(() => {}),
                signal: controller.signal,
                onClose: closed,
            }).getReader();
            await reader.read();
            if (abort) {
                controller.abort();
                await expect(reader.read()).rejects.toThrow('aborted');
            } else await reader.cancel();
            await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
            expect(closed.mock.calls[0][0]).toBeDefined();
        }
    });
});

describe('shared reader grace', () => {
    it('waits the whole grace period and releases a pin only once', () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const readers = new ProgressiveReaders(controller);
        const release = readers.pin();
        release();
        release();
        vi.advanceTimersByTime(PROGRESSIVE_READER_GRACE_MS - 1);
        expect(controller.signal.aborted).toBe(false);
        vi.advanceTimersByTime(1);
        expect(controller.signal.aborted).toBe(true);
    });
    it('cancels and restarts grace when an admitted reader rejoins', () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const readers = new ProgressiveReaders(controller);
        readers.pin()();
        vi.advanceTimersByTime(PROGRESSIVE_READER_GRACE_MS - 1);
        const release = readers.pin();
        vi.advanceTimersByTime(PROGRESSIVE_READER_GRACE_MS * 2);
        expect(controller.signal.aborted).toBe(false);
        release();
        vi.advanceTimersByTime(PROGRESSIVE_READER_GRACE_MS);
        expect(controller.signal.aborted).toBe(true);
    });
    it('lets an encode awaiting cache commit finish without readers', () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const readers = new ProgressiveReaders(controller);
        readers.pin()();
        readers.finish();
        vi.advanceTimersByTime(PROGRESSIVE_READER_GRACE_MS * 2);
        expect(controller.signal.aborted).toBe(false);
    });
});
