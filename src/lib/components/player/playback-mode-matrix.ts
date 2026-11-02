// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export type PlaybackModeClient = 'any' | 'hls.js' | 'native-hls';

export interface PlaybackModeMatrixEntry {
    mode: string;
    client: PlaybackModeClient;
    hlsAudioMode?: 'muxed' | 'demux';
    videoAction: 'copy' | 'transcode' | 'none';
    audioTracks: 'single' | 'multiple' | 'source';
    audioLanguageSwitch: 'none' | 'reload-hls' | 'in-manifest';
    expectedSyncBehavior: 'source-timestamps' | 'ffmpeg-owned-timestamps';
}

export const PLAYBACK_MODE_MATRIX: PlaybackModeMatrixEntry[] = [
    {
        mode: 'direct-play',
        client: 'any',
        videoAction: 'none',
        audioTracks: 'source',
        audioLanguageSwitch: 'in-manifest',
        expectedSyncBehavior: 'source-timestamps',
    },
    {
        mode: 'remux-api',
        client: 'any',
        videoAction: 'copy',
        audioTracks: 'source',
        audioLanguageSwitch: 'in-manifest',
        expectedSyncBehavior: 'source-timestamps',
    },
    {
        mode: 'hls-copy-muxed-web',
        client: 'hls.js',
        hlsAudioMode: 'muxed',
        videoAction: 'copy',
        audioTracks: 'single',
        audioLanguageSwitch: 'reload-hls',
        expectedSyncBehavior: 'ffmpeg-owned-timestamps',
    },
    {
        mode: 'hls-audio-transcode-muxed-web',
        client: 'hls.js',
        hlsAudioMode: 'muxed',
        videoAction: 'copy',
        audioTracks: 'single',
        audioLanguageSwitch: 'reload-hls',
        expectedSyncBehavior: 'ffmpeg-owned-timestamps',
    },
    {
        mode: 'hls-full-transcode-web',
        client: 'hls.js',
        hlsAudioMode: 'muxed',
        videoAction: 'transcode',
        audioTracks: 'single',
        audioLanguageSwitch: 'reload-hls',
        expectedSyncBehavior: 'ffmpeg-owned-timestamps',
    },
    {
        mode: 'hls-muxed-native-copy',
        client: 'native-hls',
        hlsAudioMode: 'muxed',
        videoAction: 'copy',
        audioTracks: 'single',
        audioLanguageSwitch: 'reload-hls',
        expectedSyncBehavior: 'source-timestamps',
    },
    {
        // iPhone/iPad Safari (caps `da:1`): muxed AC-3 fMP4 looped on its first
        // segment there. Exact segment times come from the GOP keyframe grid.
        mode: 'hls-demuxed-native-copy-ios',
        client: 'native-hls',
        hlsAudioMode: 'demux',
        videoAction: 'copy',
        audioTracks: 'multiple',
        audioLanguageSwitch: 'in-manifest',
        expectedSyncBehavior: 'source-timestamps',
    },
    {
        mode: 'hls-demuxed-native-full-transcode',
        client: 'native-hls',
        hlsAudioMode: 'demux',
        videoAction: 'transcode',
        audioTracks: 'multiple',
        audioLanguageSwitch: 'in-manifest',
        expectedSyncBehavior: 'ffmpeg-owned-timestamps',
    },
];

export function findPlaybackModeMatrixEntry(mode: string): PlaybackModeMatrixEntry | undefined {
    return PLAYBACK_MODE_MATRIX.find((entry) => entry.mode === mode);
}
