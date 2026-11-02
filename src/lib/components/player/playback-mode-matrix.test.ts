// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { PLAYBACK_MODE_MATRIX, findPlaybackModeMatrixEntry } from './playback-mode-matrix.js';

describe('playback mode architecture matrix', () => {
    it('documents all supported playback branches', () => {
        expect(PLAYBACK_MODE_MATRIX.map((entry) => entry.mode)).toEqual([
            'direct-play',
            'remux-api',
            'hls-copy-muxed-web',
            'hls-audio-transcode-muxed-web',
            'hls-full-transcode-web',
            'hls-muxed-native-copy',
            'hls-demuxed-native-copy-ios',
            'hls-demuxed-native-full-transcode',
        ]);
    });

    it('keeps hls.js web branches muxed with language switch via HLS reload', () => {
        for (const mode of [
            'hls-copy-muxed-web',
            'hls-audio-transcode-muxed-web',
            'hls-full-transcode-web',
        ]) {
            expect(findPlaybackModeMatrixEntry(mode)).toMatchObject({
                client: 'hls.js',
                hlsAudioMode: 'muxed',
                audioTracks: 'single',
                audioLanguageSwitch: 'reload-hls',
            });
        }
    });

    it('uses muxed HLS for native copy-mode (Safari) to avoid EXTINF drift', () => {
        expect(findPlaybackModeMatrixEntry('hls-muxed-native-copy')).toMatchObject({
            client: 'native-hls',
            hlsAudioMode: 'muxed',
            videoAction: 'copy',
            audioTracks: 'single',
            audioLanguageSwitch: 'reload-hls',
        });
    });

    it('gives iPhone/iPad native copy-mode separate audio renditions', () => {
        expect(findPlaybackModeMatrixEntry('hls-demuxed-native-copy-ios')).toMatchObject({
            client: 'native-hls',
            hlsAudioMode: 'demux',
            videoAction: 'copy',
            audioLanguageSwitch: 'in-manifest',
        });
    });

    it('keeps demuxed multi-audio for native full transcode (uniform keyframes)', () => {
        expect(findPlaybackModeMatrixEntry('hls-demuxed-native-full-transcode')).toMatchObject({
            client: 'native-hls',
            hlsAudioMode: 'demux',
            videoAction: 'transcode',
            audioTracks: 'multiple',
            audioLanguageSwitch: 'in-manifest',
        });
    });
});
