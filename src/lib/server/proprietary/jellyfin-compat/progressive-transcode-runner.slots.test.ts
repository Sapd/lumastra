// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Slot accounting of the /j progressive transcode runner. The pool is a global
 * counter (default 2); without a per-user key one user who holds a couple of
 * long-lived streams takes every slot and the rest wait out the 60 s queue for
 * a 503. FFMPEG_MAX_JOBS_PER_USER bounds a user, keyed by user id. With no
 * identity only the global cap applies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, waitSpy } = vi.hoisted(() => ({
    mockConfig: {
        FFMPEG_PATH: 'ffmpeg',
        JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT: 4,
        FFMPEG_MAX_JOBS_PER_USER: 2,
        LUMASTRA_TRANSCODE_LOAD_SHED_RATIO: 0,
        VAAPI_DEVICE: '',
        QSV_DEVICE: '',
    },
    waitSpy: vi.fn(),
}));

vi.mock('$lib/server/config', () => ({ config: mockConfig }));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
vi.mock('$lib/server/services/transcoding/hardware-detection', () => ({
    hardwareDetection: { getBestEncoder: vi.fn() },
}));
vi.mock('$lib/server/services/preview-admission.service', () => ({
    checkRealTranscodeLoadShed: () => ({ shed: false, loadRatio: 0, threshold: 0 }),
}));
vi.mock('$lib/server/services/music-transcode/source-guard', () => ({
    assertTranscodeSourceIsMedia: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/services/music-transcode/slot-wait', () => ({
    acquireWithWait: (...args: unknown[]) => waitSpy(...args),
}));

const { acquireSlot, activeProgressiveTranscodes, serveProgressiveTranscode } =
    await import('./progressive-transcode-runner');

const held: Array<() => void> = [];
async function take(userId: string | undefined): Promise<void> {
    held.push(await acquireSlot(userId));
}

beforeEach(() => {
    while (held.length) held.pop()!();
    waitSpy.mockReset();
    mockConfig.JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT = 4;
    mockConfig.FFMPEG_MAX_JOBS_PER_USER = 2;
});

describe('acquireSlot', () => {
    it('FFMPEG_MAX_JOBS_PER_USER bounds one user; others still get slots', async () => {
        await take('u-alice');
        await take('u-alice');
        await expect(take('u-alice')).rejects.toMatchObject({ status: 503 });
        await expect(take('u-bob')).resolves.toBeUndefined();
        expect(activeProgressiveTranscodes()).toBe(3);
    });

    it('releasing frees the user slot, once', async () => {
        const r1 = await acquireSlot('u-alice');
        await take('u-alice');
        await expect(take('u-alice')).rejects.toMatchObject({ status: 503 });
        r1();
        r1();
        expect(activeProgressiveTranscodes()).toBe(1);
        await expect(take('u-alice')).resolves.toBeUndefined();
    });

    it('with no identity only the global cap applies', async () => {
        await take(undefined);
        await take(undefined);
        await take(undefined);
        await take(undefined);
        await expect(take(undefined)).rejects.toMatchObject({ status: 503 });
    });

    it('the global cap holds across users', async () => {
        mockConfig.JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT = 2;
        await take('u-alice');
        await take('u-bob');
        await expect(take('u-carol')).rejects.toMatchObject({ status: 503 });
    });
});

describe('serveProgressiveTranscode wiring', () => {
    async function run(userId: string | undefined): Promise<'second-ok' | number | undefined> {
        let outcome: 'second-ok' | number | undefined;
        waitSpy.mockImplementation(async (acquire: () => Promise<() => void>) => {
            held.push(await acquire());
            try {
                held.push(await acquire());
                outcome = 'second-ok';
            } catch (err) {
                outcome = (err as { status?: number }).status;
            }
            throw Object.assign(new Error('stop here'), { status: 503 });
        });
        mockConfig.FFMPEG_MAX_JOBS_PER_USER = 1;
        await serveProgressiveTranscode({
            plan: { kind: 'transcode' } as never,
            inputPath: '/lib/a.mkv',
            request: new Request('http://localhost/j/Videos/x/stream'),
            itemId: 'item',
            username: 'alice',
            userId,
        });
        return outcome;
    }

    it('hands the request identity to the slot acquirer (second slot of one user is refused)', async () => {
        expect(await run('u-alice')).toBe(503);
    });

    it('with no identity the same acquirer is not per-user limited', async () => {
        expect(await run(undefined)).toBe('second-ok');
    });
});
