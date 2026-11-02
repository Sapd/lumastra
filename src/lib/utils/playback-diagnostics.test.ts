// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    classifyHlsFailureStage,
    classifyHttpPlaybackDiagnostic,
    parseStreamDiagnosticCode,
} from './playback-diagnostics';

describe('playback diagnostics', () => {
    it.each([
        [401, 'authorization-rejected'],
        [403, 'authorization-rejected'],
        [404, 'media-not-found'],
        [408, 'request-timeout'],
        [429, 'stream-limit'],
        [500, 'server-error'],
        [502, 'gateway-unavailable'],
        [503, 'gateway-unavailable'],
        [504, 'gateway-timeout'],
    ] as const)('classifies HTTP %i as %s', (status, expected) => {
        expect(classifyHttpPlaybackDiagnostic(status)).toBe(expected);
    });

    it('classifies HLS request stages', () => {
        expect(classifyHlsFailureStage('manifestLoadError')).toBe('manifest');
        expect(classifyHlsFailureStage('fragLoadError', 'main', 'initSegment')).toBe(
            'init-segment',
        );
        expect(classifyHlsFailureStage('fragParsingError')).toBe('media-segment');
        expect(classifyHlsFailureStage(undefined)).toBe('unknown');
    });

    it('accepts only allow-listed server codes', () => {
        expect(parseStreamDiagnosticCode('transcoder-start-failed')).toBe(
            'transcoder-start-failed',
        );
        expect(parseStreamDiagnosticCode('playback-method-not-allowed')).toBe(
            'playback-method-not-allowed',
        );
        expect(parseStreamDiagnosticCode('/mnt/media/secret.mkv')).toBeNull();
        expect(parseStreamDiagnosticCode('https://secret.example/token')).toBeNull();
    });
});
