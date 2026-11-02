// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { renditionToWire } from './wire';
import type {
    DownloadRenditionRow,
    RenditionStatus,
} from '$lib/server/database/queries/download-renditions.queries';

function row(overrides: Partial<DownloadRenditionRow> = {}): DownloadRenditionRow {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        file_id: '22222222-2222-4222-8222-222222222222',
        media_item_id: '33333333-3333-4333-8333-333333333333',
        rung_id: '720p',
        audio_index: 2,
        status: 'ready',
        progress_pct: 100,
        size_bytes: '1400000000',
        artifact_name: '11111111-1111-4111-8111-111111111111.mp4',
        error_code: null,
        owner_pod: 'web-1',
        heartbeat_at: null,
        created_at: new Date(0),
        updated_at: new Date(0),
        last_accessed_at: new Date(0),
        ...overrides,
    };
}

describe('renditionToWire', () => {
    it('exposes a download URL for a ready rendition', () => {
        const wire = renditionToWire(row(), 'v1');
        expect(wire.url).toContain('/renditions/11111111-1111-4111-8111-111111111111/file');
        expect(wire.sizeBytes).toBe(1_400_000_000);
    });

    // A URL on an unfinished rendition invites a client to start downloading a
    // file that does not exist yet — the artifact is only renamed into place at
    // the very end of the encode.
    it.each<RenditionStatus>(['queued', 'encoding', 'failed'])(
        'withholds the URL while status is %s',
        (status) => {
            const wire = renditionToWire(row({ status, artifact_name: null }), 'v1');
            expect(wire.url).toBeUndefined();
        },
    );

    it('withholds size_bytes until the artifact is real', () => {
        expect(renditionToWire(row({ status: 'encoding' }), 'v1').sizeBytes).toBeUndefined();
    });

    it('surfaces the error code for a failed rendition', () => {
        const wire = renditionToWire(row({ status: 'failed', error_code: 'encode_failed' }), 'v1');
        expect(wire.errorCode).toBe('encode_failed');
        expect(wire.url).toBeUndefined();
    });

    it('carries progress through unchanged', () => {
        expect(
            renditionToWire(row({ status: 'encoding', progress_pct: 42 }), 'v1').progressPct,
        ).toBe(42);
    });

    it('reports the rung and audio track the artifact was built for', () => {
        const wire = renditionToWire(row({ rung_id: '1080p', audio_index: 5 }), 'v1');
        expect(wire.rungId).toBe('1080p');
        expect(wire.audioIndex).toBe(5);
    });
});
