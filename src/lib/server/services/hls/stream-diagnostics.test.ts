// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    buildExplicitStreamDiagnosticHeaders,
    buildStreamDiagnosticHeaders,
    getPublicHlsDiagnosticCode,
    getStreamDiagnosticCode,
} from './stream-diagnostics';

describe('stream diagnostics header contract', () => {
    it('only emits allow-listed codes for confirmed server states', () => {
        expect(getStreamDiagnosticCode({ branch: 'deleted' })).toBe('session-expired');
        expect(getStreamDiagnosticCode({ branch: 'backward_seek_timeout' })).toBe(
            'upstream-timeout',
        );
        expect(getStreamDiagnosticCode({ branch: 'segment_not_found' })).toBeNull();
    });

    it('uses an opaque bounded correlation ID and no free-form data', () => {
        const headers = buildStreamDiagnosticHeaders({ branch: 'deleted' });
        expect(headers['X-Lumastra-Diagnostic-Code']).toBe('session-expired');
        expect(headers['X-Lumastra-Diagnostic-Id']).toMatch(/^pd_[a-f0-9]{16}$/);
        expect(Object.values(headers).join(' ')).not.toContain('/');
    });

    it('only accepts an explicit allowlisted code from an API route', () => {
        expect(buildExplicitStreamDiagnosticHeaders(null)).toEqual({});
        const headers = buildExplicitStreamDiagnosticHeaders('concurrency-limit');
        expect(headers['X-Lumastra-Diagnostic-Code']).toBe('concurrency-limit');
        expect(headers['X-Lumastra-Diagnostic-Id']).toMatch(/^pd_[a-f0-9]{16}$/);
    });

    it('only attributes FFmpeg to an explicit startup failure', () => {
        expect(
            getPublicHlsDiagnosticCode({
                statusCode: 503,
                errorCode: 'transcode_start_failed',
            }),
        ).toBe('transcoder-start-failed');
        expect(getPublicHlsDiagnosticCode({ statusCode: 503, errorCode: 'transcode_failed' })).toBe(
            null,
        );
        expect(
            getPublicHlsDiagnosticCode({
                statusCode: 503,
                errorCode: 'transcode_start_interrupted',
            }),
        ).toBeNull();
        expect(getPublicHlsDiagnosticCode({ statusCode: 503 })).toBeNull();
        expect(getPublicHlsDiagnosticCode({ statusCode: 429 })).toBe('concurrency-limit');
    });

    it.each(['transcode_capacity', 'transcode_load_shed'])(
        'marks a 503 %s refusal as concurrency-limit',
        (errorCode) => {
            expect(getPublicHlsDiagnosticCode({ statusCode: 503, errorCode })).toBe(
                'concurrency-limit',
            );
            expect(getPublicHlsDiagnosticCode({ statusCode: 500, errorCode })).toBeNull();
        },
    );

    it('marks a 403 as the play-method refusal only with the structured policy body', () => {
        expect(
            getPublicHlsDiagnosticCode({ statusCode: 403, errorCode: 'transcode_not_allowed' }),
        ).toBe('playback-method-not-allowed');
        expect(getPublicHlsDiagnosticCode({ statusCode: 403 })).toBeNull();
        expect(
            getPublicHlsDiagnosticCode({ statusCode: 401, errorCode: 'transcode_not_allowed' }),
        ).toBeNull();
    });
});
