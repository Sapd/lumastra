// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it } from 'vitest';
import { addVttTimeMap, applySubtitleWindow, buildSubtitlePlaylist } from './subtitle-stream';

const S = 10_000_000; // ticks per second

const VTT = [
    'WEBVTT',
    '',
    'NOTE kept',
    '',
    '00:00:01.000 --> 00:00:02.000',
    'one',
    '',
    'cue-2',
    '00:00:09.500 --> 00:00:11.000 align:start',
    'two',
    '',
    '00:20.000 --> 00:21.250',
    'three',
    '',
].join('\n');

const SRT = [
    '1',
    '00:00:01,000 --> 00:00:02,000',
    'one',
    '',
    '2',
    '00:00:09,500 --> 00:00:11,000',
    'two',
    'second line',
    '',
    '3',
    '01:00:20,000 --> 01:00:21,000',
    'three',
    '',
].join('\n');

describe('applySubtitleWindow (Jellyfin FilterEvents)', () => {
    it('drops cues that ended before the start and shifts the rest', () => {
        const out = applySubtitleWindow(VTT, 'vtt', {
            startTicks: 10 * S,
            endTicks: 0,
            copyTimestamps: false,
        });
        expect(out).toBe(
            [
                'WEBVTT',
                '',
                'NOTE kept',
                '',
                'cue-2',
                '00:00:00.000 --> 00:00:01.000 align:start',
                'two',
                '',
                '00:00:10.000 --> 00:00:11.250',
                'three',
                '',
            ].join('\n'),
        );
    });

    it('keeps the source timeline with CopyTimestamps and cuts after the end', () => {
        const out = applySubtitleWindow(VTT, 'vtt', {
            startTicks: 9 * S,
            endTicks: 12 * S,
            copyTimestamps: true,
        });
        expect(out).toContain('00:00:09.500 --> 00:00:11.000 align:start');
        expect(out).not.toContain('one');
        expect(out).not.toContain('three');
    });

    it('keeps a cue that starts after the end tick only if it starts at it', () => {
        const out = applySubtitleWindow(VTT, 'vtt', {
            startTicks: 0,
            endTicks: 20 * S,
            copyTimestamps: true,
        });
        expect(out).toContain('three');
    });

    it('renumbers SRT cues and keeps multi-line text and hours', () => {
        const out = applySubtitleWindow(SRT, 'srt', {
            startTicks: 5 * S,
            endTicks: 0,
            copyTimestamps: false,
        });
        expect(out).toBe(
            [
                '1',
                '00:00:04,500 --> 00:00:06,000',
                'two',
                'second line',
                '',
                '2',
                '01:00:15,000 --> 01:00:16,000',
                'three',
                '',
            ].join('\n'),
        );
    });

    it('preserves CRLF line endings', () => {
        const out = applySubtitleWindow(SRT.replace(/\n/g, '\r\n'), 'srt', {
            startTicks: 0,
            endTicks: 3 * S,
            copyTimestamps: true,
        });
        expect(out).toBe('1\r\n00:00:01,000 --> 00:00:02,000\r\none\r\n');
    });
});

describe('addVttTimeMap', () => {
    it('adds the MPEG-TS anchor under the header only', () => {
        expect(addVttTimeMap('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nWEBVTT text\n')).toBe(
            'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nWEBVTT text\n',
        );
    });
});

describe('buildSubtitlePlaylist (Jellyfin GetSubtitlePlaylist)', () => {
    it('cuts the runtime into windowed Stream.vtt segments', () => {
        const out = buildSubtitlePlaylist(25 * S, 10, 'tok');
        expect(out).toBe(
            [
                '#EXTM3U',
                '#EXT-X-TARGETDURATION:10',
                '#EXT-X-VERSION:3',
                '#EXT-X-MEDIA-SEQUENCE:0',
                '#EXT-X-PLAYLIST-TYPE:VOD',
                '#EXTINF:10,',
                `Stream.vtt?CopyTimestamps=true&AddVttTimeMap=true&StartPositionTicks=0&EndPositionTicks=${10 * S}&api_key=tok`,
                '#EXTINF:10,',
                `Stream.vtt?CopyTimestamps=true&AddVttTimeMap=true&StartPositionTicks=${10 * S}&EndPositionTicks=${20 * S}&api_key=tok`,
                '#EXTINF:5,',
                `Stream.vtt?CopyTimestamps=true&AddVttTimeMap=true&StartPositionTicks=${20 * S}&EndPositionTicks=${25 * S}&api_key=tok`,
                '#EXT-X-ENDLIST',
                '',
            ].join('\n'),
        );
    });

    it('omits api_key when there is no replayable token', () => {
        expect(buildSubtitlePlaylist(5 * S, 10, '')).not.toContain('api_key');
    });
});
