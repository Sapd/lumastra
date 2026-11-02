// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    DOWNLOAD_RUNGS,
    getDownloadRung,
    estimateRenditionBytes,
    rungsForSourceHeight,
    clampRungForHeight,
} from './download-rungs';

describe('DOWNLOAD_RUNGS', () => {
    it('is ordered highest-quality first', () => {
        const heights = DOWNLOAD_RUNGS.map((r) => r.height);
        expect(heights).toEqual([...heights].sort((a, b) => b - a));
    });

    it('has unique ids', () => {
        const ids = DOWNLOAD_RUNGS.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('resolves a rung by id', () => {
        expect(getDownloadRung('720p')?.height).toBe(720);
    });

    it('returns undefined for an unknown id', () => {
        expect(getDownloadRung('4k')).toBeUndefined();
    });

    // Sizing the ladder for offline use is the entire reason it is not
    // LIVETV_RUNGS — a rung that costs more than the source defeats the feature.
    it('keeps a 2-hour 1080p download well under 4 GB', () => {
        const rung = getDownloadRung('1080p');
        expect(rung).toBeDefined();
        const bytes = estimateRenditionBytes(rung!, 2 * 60 * 60 * 1000);
        expect(bytes).not.toBeNull();
        expect(bytes!).toBeLessThan(4 * 1024 ** 3);
    });
});

describe('estimateRenditionBytes', () => {
    it('scales linearly with duration', () => {
        const rung = DOWNLOAD_RUNGS[0];
        const oneHour = estimateRenditionBytes(rung, 3_600_000)!;
        const twoHours = estimateRenditionBytes(rung, 7_200_000)!;
        expect(twoHours / oneHour).toBeCloseTo(2, 5);
    });

    it('is larger for a higher rung at the same duration', () => {
        const hd = estimateRenditionBytes(getDownloadRung('1080p')!, 3_600_000)!;
        const sd = estimateRenditionBytes(getDownloadRung('360p')!, 3_600_000)!;
        expect(hd).toBeGreaterThan(sd);
    });

    // A 0 would render as "0 B" in a picker and read as a free download.
    it('returns null rather than 0 for an unknown duration', () => {
        expect(estimateRenditionBytes(DOWNLOAD_RUNGS[0], null)).toBeNull();
        expect(estimateRenditionBytes(DOWNLOAD_RUNGS[0], 0)).toBeNull();
        expect(estimateRenditionBytes(DOWNLOAD_RUNGS[0], Number.NaN)).toBeNull();
        expect(estimateRenditionBytes(DOWNLOAD_RUNGS[0], -1)).toBeNull();
    });

    it('includes container overhead', () => {
        const rung = DOWNLOAD_RUNGS[0];
        const media = ((rung.videoBitrate + rung.audioBitrate) * 60) / 8;
        expect(estimateRenditionBytes(rung, 60_000)!).toBeGreaterThan(media);
    });

    // The series-candidates path has no probe and cannot answer, so the default
    // has to be the pessimistic one — an estimate that reads LOW is the one that
    // hurts a user budgeting against a metered connection.
    it('budgets audio by default', () => {
        const rung = DOWNLOAD_RUNGS[0];
        expect(estimateRenditionBytes(rung, 3_600_000)).toBe(
            estimateRenditionBytes(rung, 3_600_000, true),
        );
    });

    it('drops the audio bitrate for a video-only encode', () => {
        const rung = DOWNLOAD_RUNGS[0];
        const withAudio = estimateRenditionBytes(rung, 3_600_000, true)!;
        const videoOnly = estimateRenditionBytes(rung, 3_600_000, false)!;
        expect(videoOnly).toBeLessThan(withAudio);
        // Exactly the audio term, container overhead included.
        const audioBits = rung.audioBitrate * 3600;
        expect(withAudio - videoOnly).toBe(Math.round((audioBits / 8) * 1.02));
    });

    it('still returns null for an unknown duration on a video-only source', () => {
        expect(estimateRenditionBytes(DOWNLOAD_RUNGS[0], null, false)).toBeNull();
    });
});

describe('rungsForSourceHeight', () => {
    it('never offers to upscale', () => {
        expect(rungsForSourceHeight(720).every((r) => r.height <= 720)).toBe(true);
    });

    it('offers the whole ladder for a 4K source', () => {
        expect(rungsForSourceHeight(2160)).toHaveLength(DOWNLOAD_RUNGS.length);
    });

    it('offers every rung when the source height is unknown', () => {
        expect(rungsForSourceHeight(null)).toHaveLength(DOWNLOAD_RUNGS.length);
    });

    // An empty picker is a dead-end UI — a tiny source still gets one option.
    it('offers the smallest rung for a source below the ladder', () => {
        const rungs = rungsForSourceHeight(240);
        expect(rungs).toHaveLength(1);
        expect(rungs[0].id).toBe('360p');
    });
});

describe('clampRungForHeight', () => {
    it('returns the requested rung when the source can carry it', () => {
        expect(clampRungForHeight('720p', 1080)?.id).toBe('720p');
    });

    it('clamps a request above the source down to the best offered rung', () => {
        // THE BUG THIS EXISTS TO PREVENT: budgeting 1080p bytes for an encode
        // the ffmpeg args will produce at 720p overshoots every item by ~60%,
        // and eviction then fires against files the user actually wanted.
        expect(clampRungForHeight('1080p', 720)?.id).toBe('720p');
    });

    it('clamps to the smallest rung for a source below the whole ladder', () => {
        // rungsForSourceHeight returns [360p] for a 240-line source, since the
        // picker must never be empty; the encode re-scales to the source height.
        expect(clampRungForHeight('1080p', 240)?.id).toBe('360p');
    });

    it('passes the request through unclamped when the height is unknown', () => {
        // rungsForSourceHeight(null) returns the full ladder, so the requested
        // rung stands and the estimate stands with it.
        expect(clampRungForHeight('1080p', null)?.id).toBe('1080p');
    });

    it('never upscales a request below the source', () => {
        expect(clampRungForHeight('360p', 1080)?.id).toBe('360p');
    });

    it('returns undefined for an unknown rung id rather than guessing', () => {
        expect(clampRungForHeight('4k', 2160)).toBeUndefined();
    });
});
