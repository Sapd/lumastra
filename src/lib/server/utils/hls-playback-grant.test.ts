// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    generateMasterPlaylist,
    generateMuxedMasterPlaylist,
    generateAudioOnlyMasterPlaylist,
} from './hls-master-playlist.js';
import {
    generateCompleteVodManifest,
    rewriteMediaPlaylist,
    buildGopGridManifest,
} from '../services/hls/vod-playlist.js';
import { handleTrickplayPlaylist } from '../handlers/hls/trickplay-handler.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';

function assertGranted(playlist: string): string[] {
    const uris = playlist.split('\n').flatMap((line) => {
        const value = line.trim();
        return value.startsWith('#')
            ? Array.from(value.matchAll(/URI="([^"]+)"/g), (match) => match[1])
            : value
              ? [value]
              : [];
    });
    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) {
        expect(new URL(uri, 'https://player.test/').searchParams.get('grant'), uri).toBe(
            'stream_secret',
        );
    }
    return uris;
}

const params = new URLSearchParams({ grant: 'stream_secret', PlaySessionId: 'session' });

describe('external-player playlist credentials', () => {
    it('carries the grant through generated master, media, init, subtitle, trickplay and iframe URIs', async () => {
        const master = generateMasterPlaylist(
            [
                {
                    index: asAbsoluteStreamIndex(1),
                    displayTitle: 'English',
                    language: 'eng',
                    codec: 'aac',
                    channels: 2,
                    isDefault: true,
                },
            ],
            [
                {
                    index: 2,
                    displayTitle: 'English',
                    language: 'eng',
                    codec: 'srt',
                    isTextBased: true,
                    isDefault: true,
                    isForced: false,
                },
            ],
            '/api/v1/playback/item/hls',
            params,
            5_000_000,
            { codec: 'h264', width: 1920, height: 1080, bitrate: 4_000_000 },
            undefined,
            'item',
            'file',
            {
                width: 320,
                height: 180,
                tileWidth: 10,
                tileHeight: 10,
                thumbnailCount: 100,
                interval: 10000,
                bandwidth: 15000,
            },
            { includeTrickplay: true, syntheticIframes: true },
        );
        expect(master).toContain('TYPE=SUBTITLES');
        expect(master).toContain('#EXT-X-I-FRAME-STREAM-INF');
        expect(master).toContain('#EXT-X-IMAGE-STREAM-INF');
        const uris = assertGranted(master);
        const media = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"',
            {
                totalDurationSeconds: 18,
                segmentDurationSeconds: 6,
                totalSegments: 3,
                isComplete: true,
            },
            params,
        );
        assertGranted(media);
        const trickplay = uris.find((uri) => uri.includes('trickplay.m3u8'));
        expect(trickplay).toBeDefined();
        const response = await handleTrickplayPlaylist(
            'item',
            new URL(trickplay!, 'https://player.test/'),
        );
        expect(response.status).toBe(200);
        assertGranted(await response.text());
    });

    it('carries grants through muxed/audio-only masters and GOP media playlists', () => {
        const mediaUri = `/api/v1/playback/item/hls?${params}`;
        const subtitles = [
            {
                index: 2,
                displayTitle: 'English',
                language: 'eng',
                codec: 'srt',
                isTextBased: true,
                isDefault: true,
                isForced: false,
            },
        ];
        assertGranted(
            generateMuxedMasterPlaylist(mediaUri, 5_000_000, undefined, undefined, undefined, {
                segmentBase: '/api/v1/playback/item/hls',
                params,
                fileId: 'file',
                subtitleTracks: subtitles,
            }),
        );
        assertGranted(
            generateAudioOnlyMasterPlaylist(
                mediaUri,
                128000,
                subtitles,
                '/api/v1/playback/item/hls',
                params,
                'file',
            ),
        );
        assertGranted(
            buildGopGridManifest({ durations: [6, 6, 6], count: 3 }, 'init_0.mp4', params),
        );
    });

    it('rewrites every URI attribute and merges existing queries before fragments', () => {
        const playlist = rewriteMediaPlaylist(
            [
                '#EXTM3U',
                '#EXT-X-MAP:URI="init.mp4?track=2#init"',
                '#EXT-X-MEDIA:URI="subtitles.m3u8?lang=en",TYPE=SUBTITLES',
                '#EXT-X-I-FRAME-STREAM-INF:URI="iframe.m3u8"',
                '#EXT-X-KEY:METHOD=AES-128,URI="key?version=1"',
                '#EXTINF:6,',
                'segment.m4s?part=3#bytes',
            ].join('\n'),
            params,
        );
        assertGranted(playlist);
        expect(playlist).toContain(
            'init.mp4?track=2&grant=stream_secret&PlaySessionId=session#init',
        );
        expect(playlist).toContain(
            'segment.m4s?part=3&grant=stream_secret&PlaySessionId=session#bytes',
        );
    });
});

it('does not attach grant or session to a foreign master rendition base', () => {
    const playlist = generateMasterPlaylist(
        [],
        [],
        'https://cdn.test/api/playback/id/hls',
        params,
        1_000_000,
    );
    const uriLines = playlist.split('\n').filter((line) => line.startsWith('https://cdn.test'));
    expect(uriLines.length).toBeGreaterThan(0);
    for (const uri of uriLines) {
        expect(new URL(uri).searchParams.has('grant')).toBe(false);
        expect(new URL(uri).searchParams.has('PlaySessionId')).toBe(false);
    }
});
