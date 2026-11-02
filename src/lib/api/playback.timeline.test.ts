// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineResponseSchema } from '$lib/schemas/api-playback-responses';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('./client.js', () => ({ apiGet, apiPost: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn() }));
import { getTimelineByHref } from './playback';

const timeline = {
    fileId: 'selected-file',
    durationMs: 120_000,
    chapters: [
        {
            index: 0,
            name: 'Opening',
            startMs: 1250,
            endMs: 60_000,
            image: {
                href: '/ready/chapter?fileId=selected&grant=opaque&rev=one',
                revision: 'one',
                source: 'self',
            },
        },
    ],
    segments: [{ type: 'intro', startMs: 1250, endMs: 25_500 }],
    segmentAnalysis: 'analyzed',
    hasIntro: true,
    hasOutro: false,
    trickplay: {
        state: 'ready',
        variants: [{ width: 320, manifestHref: '/manifest?grant=opaque' }],
    },
};

beforeEach(() => apiGet.mockReset());

describe('getTimelineByHref', () => {
    it('uses the server schema and preserves selected-file times and ready hrefs', async () => {
        apiGet.mockResolvedValue({ data: TimelineResponseSchema.parse(timeline) });
        const { data } = await getTimelineByHref('/ready/timeline?fileId=file%2Fid&grant=opaque');
        expect(apiGet).toHaveBeenCalledWith(
            '/ready/timeline?fileId=file%2Fid&grant=opaque',
            TimelineResponseSchema,
        );
        expect(data).toEqual(timeline);
    });

    it('follows a plain server href unchanged', async () => {
        await getTimelineByHref('/ready/timeline');
        expect(apiGet).toHaveBeenCalledWith('/ready/timeline', TimelineResponseSchema);
    });

    it('rejects obsolete tick chapters and seconds-based segments', () => {
        expect(() =>
            TimelineResponseSchema.parse({
                ...timeline,
                chapters: [{ index: 0, name: 'Opening', startPositionTicks: 12_500_000 }],
                segments: [{ type: 'Intro', startTime: 1.25, endTime: 25.5 }],
            }),
        ).toThrow();
    });
});
