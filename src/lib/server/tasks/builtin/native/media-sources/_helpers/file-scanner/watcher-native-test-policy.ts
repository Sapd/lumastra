// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { NativeWatcherPolicyV2 } from './watcher-native-protocol.js';

/** Fixed v2 init policy for bridge tests that never reach a real filesystem child. */
export const TEST_NATIVE_POLICY: NativeWatcherPolicyV2 = {
    mediaExtensions: ['.mkv'],
    audioExtensions: ['.flac'],
    lyricsExtensions: ['.lrc', '.txt'],
    prunedDirectoryNames: ['extras', '@eadir'],
    prunedDirectoryPrefixes: ['@', '.trash-'],
    prunedDirectorySuffixes: ['.trickplay'],
    ignoredFilePrefixes: ['._'],
    sampleWord: 'sample',
    ignoreFiles: {
        patternFile: '.lumastraignore',
        markerFile: '.ignore',
        maxBytes: 65536,
        maxPatternLength: 512,
        maxPatternsPerFile: 1000,
        maxAccumulatedPatterns: 5000,
    },
    containmentRoots: ['/media'],
    sensitivePrefixes: ['/proc'],
};
