// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it } from 'vitest';
import {
    buildProgressiveArgs,
    parseProgressiveRequest,
    planProgressiveTranscode,
    type ProgressiveRequest,
    type ProgressiveSource,
    type VideoEncoderChoice,
} from './progressive-transcode';

/** The URL Moonfin builds for its "720p" download preset (download_service.dart). */
const MOONFIN_720P =
    'MediaSourceId=e3158e7b9d584eee8ede509d22833e1b&ApiKey=k&Static=false&videoCodec=hevc' +
    '&audioCodec=aac&videoBitRate=3000000&audioBitRate=128000&maxWidth=1280&container=mp4' +
    '&audioChannels=2&PlaySessionId=p&DeviceId=d';

/** Late Fame as scanned on prod: 1792x1080 H.264 + 5.1 E-AC-3 in MKV. */
const LATE_FAME: ProgressiveSource = {
    container: 'mkv',
    video: { codec: 'h264', width: 1792, height: 1080, bitrate: 9_038_193, isHdr: false },
    audio: [{ index: 1, codec: 'eac3', channels: 6, isDefault: true }],
};

const QSV_HEVC: VideoEncoderChoice = {
    name: 'hevc_qsv',
    codec: 'hevc',
    initArgs: [],
    needsHwUpload: false,
    preset: 'veryfast',
    pixFmt: 'nv12',
};

function req(query: string): ProgressiveRequest {
    const parsed = parseProgressiveRequest(new URLSearchParams(query));
    if (!parsed) throw new Error('expected a progressive request');
    return parsed;
}

describe('parseProgressiveRequest', () => {
    it("parses Moonfin's download URL", () => {
        expect(req(MOONFIN_720P)).toEqual({
            container: 'mp4',
            videoCodecs: ['hevc'],
            audioCodecs: ['aac'],
            videoBitrate: 3_000_000,
            audioBitrate: 128_000,
            maxWidth: 1280,
            maxHeight: null,
            audioChannels: 2,
            audioStreamIndex: null,
            startSeconds: 0,
        });
    });

    it('is not a transcode request when static or without a container', () => {
        expect(
            parseProgressiveRequest(new URLSearchParams('static=true&container=mp4')),
        ).toBeNull();
        expect(
            parseProgressiveRequest(new URLSearchParams('Static=True&Container=mp4')),
        ).toBeNull();
        expect(
            parseProgressiveRequest(new URLSearchParams('Static=false&videoCodec=h264')),
        ).toBeNull();
        expect(parseProgressiveRequest(new URLSearchParams('container=webm'))).toBeNull();
    });

    it('matches keys case-insensitively and normalises codec aliases', () => {
        const r = req(
            'CONTAINER=MKV&VideoCodec=h265,AVC&AudioStreamIndex=3&StartTimeTicks=600000000',
        );
        expect(r.container).toBe('mkv');
        expect(r.videoCodecs).toEqual(['hevc', 'h264']);
        expect(r.audioStreamIndex).toBe(3);
        expect(r.startSeconds).toBe(60);
    });
});

describe('planProgressiveTranscode', () => {
    it('re-encodes Late Fame for Moonfin 720p: HEVC at the asked bitrate, stereo AAC', () => {
        const plan = planProgressiveTranscode(req(MOONFIN_720P), LATE_FAME);
        expect(plan).toEqual({
            kind: 'transcode',
            container: 'mp4',
            video: {
                mode: 'encode',
                codec: 'hevc',
                bitrate: 3_000_000,
                maxWidth: 1280,
                maxHeight: null,
                tonemap: false,
            },
            audio: {
                mode: 'encode',
                index: 1,
                codec: 'aac',
                encoder: 'aac',
                channels: 2,
                bitrate: 128_000,
            },
            startSeconds: 0,
        });
    });

    it('copies video and converts only the audio when the video already fits', () => {
        const plan = planProgressiveTranscode(
            req('container=mp4&videoCodec=h264,hevc&audioCodec=aac&audioChannels=2'),
            LATE_FAME,
        );
        expect(plan.kind === 'transcode' && plan.video).toEqual({ mode: 'copy', codec: 'h264' });
        expect(plan.kind === 'transcode' && plan.audio?.mode).toBe('encode');
    });

    it('copies E-AC-3 into MP4 when the client accepts it (a pure remux)', () => {
        const plan = planProgressiveTranscode(
            req('container=mp4&videoCodec=h264&audioCodec=aac,eac3'),
            LATE_FAME,
        );
        expect(plan).toMatchObject({
            kind: 'transcode',
            video: { mode: 'copy' },
            audio: { mode: 'copy', index: 1 },
        });
    });

    it('serves the original when nothing would change', () => {
        expect(
            planProgressiveTranscode(
                req('container=mkv&videoCodec=h264&audioCodec=eac3'),
                LATE_FAME,
            ),
        ).toEqual({ kind: 'original' });
        expect(planProgressiveTranscode(req('container=mkv'), LATE_FAME)).toEqual({
            kind: 'original',
        });
    });

    it('remuxes when a seek or a non-default audio track is asked for', () => {
        const twoTracks: ProgressiveSource = {
            ...LATE_FAME,
            audio: [
                { index: 1, codec: 'eac3', channels: 6, isDefault: true },
                { index: 2, codec: 'eac3', channels: 6, isDefault: false },
            ],
        };
        expect(
            planProgressiveTranscode(req('container=mkv&AudioStreamIndex=2'), twoTracks),
        ).toMatchObject({
            kind: 'transcode',
            audio: { mode: 'copy', index: 2 },
        });
        expect(
            planProgressiveTranscode(req('container=mkv&StartTimeTicks=10000000'), LATE_FAME),
        ).toMatchObject({ kind: 'transcode', startSeconds: 1 });
    });

    it('never asks for more video bits than the source has', () => {
        const plan = planProgressiveTranscode(
            req('container=mp4&videoCodec=h264&maxWidth=1280&videoBitRate=40000000'),
            LATE_FAME,
        );
        expect(plan.kind === 'transcode' && plan.video).toMatchObject({
            mode: 'encode',
            bitrate: 9_038_193,
        });
    });

    it('tone-maps an HDR source it has to encode', () => {
        const hdr: ProgressiveSource = {
            ...LATE_FAME,
            video: { codec: 'hevc', width: 3840, height: 2160, bitrate: 40_000_000, isHdr: true },
        };
        const plan = planProgressiveTranscode(req(MOONFIN_720P), hdr);
        expect(plan.kind === 'transcode' && plan.video).toMatchObject({
            mode: 'encode',
            tonemap: true,
        });
    });

    it('falls back to H.264 and AAC when the client lists nothing we can encode', () => {
        const plan = planProgressiveTranscode(
            req('container=mp4&videoCodec=vp9&audioCodec=vorbis'),
            LATE_FAME,
        );
        expect(plan).toMatchObject({
            kind: 'transcode',
            video: { mode: 'encode', codec: 'h264' },
            audio: { mode: 'encode', codec: 'aac', channels: 6 },
        });
    });
});

describe('buildProgressiveArgs', () => {
    it('builds a fragmented-MP4 pipe for the Moonfin plan', () => {
        const plan = planProgressiveTranscode(req(MOONFIN_720P), LATE_FAME);
        if (plan.kind !== 'transcode') throw new Error('expected transcode');
        const args = buildProgressiveArgs(plan, '/data/movies/Late Fame.mkv', QSV_HEVC);
        const joined = args.join(' ');

        expect(args.slice(args.indexOf('-i') - 2, args.indexOf('-i') + 2)).toEqual([
            '-protocol_whitelist',
            'file',
            '-i',
            '/data/movies/Late Fame.mkv',
        ]);
        expect(joined).toContain('-map 0:v:0 -map 0:1 -sn -dn');
        expect(joined).toContain("-vf scale='min(iw\\,1280)':-2");
        expect(joined).toContain('-c:v hevc_qsv -preset veryfast -profile:v main -pix_fmt nv12');
        expect(joined).toContain('-b:v 3000000 -maxrate 4500000 -bufsize 6000000');
        expect(joined).toContain('-tag:v hvc1');
        expect(joined).toContain('-c:a aac -ac 2 -b:a 128000 -ar 48000');
        expect(joined).toContain('-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof');
        expect(args.at(-1)).toBe('pipe:1');
    });

    it('ends a VA-API filter chain with an upload and passes no pix_fmt', () => {
        const plan = planProgressiveTranscode(req(MOONFIN_720P), LATE_FAME);
        if (plan.kind !== 'transcode') throw new Error('expected transcode');
        const args = buildProgressiveArgs(plan, '/in.mkv', {
            name: 'hevc_vaapi',
            codec: 'hevc',
            initArgs: ['-vaapi_device', '/dev/dri/renderD128'],
            needsHwUpload: true,
            preset: null,
            pixFmt: null,
        });
        expect(args.slice(0, 6)).toEqual([
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'warning',
            '-vaapi_device',
            '/dev/dri/renderD128',
        ]);
        expect(args[args.indexOf('-vf') + 1]).toMatch(/,format=nv12,hwupload$/);
        expect(args).not.toContain('-pix_fmt');
    });

    it('copies, seeks before the input, and drops audio when there is none', () => {
        const plan = planProgressiveTranscode(req('container=ts&StartTimeTicks=95000000'), {
            container: 'mkv',
            video: { codec: 'h264', width: 1920, height: 1080, bitrate: 5_000_000, isHdr: false },
            audio: [],
        });
        if (plan.kind !== 'transcode') throw new Error('expected transcode');
        const args = buildProgressiveArgs(plan, '/in.mkv', null);
        expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
        expect(args[args.indexOf('-ss') + 1]).toBe('9.500');
        expect(args.join(' ')).toContain('-map_chapters -1 -c:v copy -an -f mpegts pipe:1');
    });
});
