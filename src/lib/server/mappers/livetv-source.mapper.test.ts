// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { mapSourceWithChannelCountToApi } from './livetv-source.mapper.js';

function row(overrides: Record<string, unknown>) {
    return {
        id: 's1',
        name: 'Provider',
        source_type: 'm3u',
        max_streams: 1,
        refresh_cron: null,
        last_refresh_at: null,
        last_refresh_status: null,
        last_refresh_summary: null,
        created_at: new Date(),
        updated_at: new Date(),
        channel_count: 100,
        tvg_id_count: 0,
        ...overrides,
    } as unknown as Parameters<typeof mapSourceWithChannelCountToApi>[0];
}

describe('mapSourceWithChannelCountToApi — playlistMetadataMissing', () => {
    it('flags a non-empty M3U source whose channels carry no tvg-id', () => {
        expect(mapSourceWithChannelCountToApi(row({})).playlistMetadataMissing).toBe(true);
    });

    it('does not flag a playlist with tvg-ids, an empty source, or a non-M3U source', () => {
        expect(
            mapSourceWithChannelCountToApi(row({ tvg_id_count: 3 })).playlistMetadataMissing,
        ).toBe(false);
        expect(
            mapSourceWithChannelCountToApi(row({ channel_count: 0 })).playlistMetadataMissing,
        ).toBe(false);
        expect(
            mapSourceWithChannelCountToApi(row({ source_type: 'xtream' })).playlistMetadataMissing,
        ).toBe(false);
    });
});

it('returns the failed source summary with credentials redacted', () => {
    const row = {
        id: 'source',
        name: 'Provider',
        source_type: 'm3u',
        max_streams: 1,
        last_refresh_status: 'failed',
        last_refresh_at: null,
        refresh_cron: null,
        created_at: new Date(),
        updated_at: new Date(),
        channel_count: 5,
        tvg_id_count: 5,
        last_refresh_summary: {
            error: 'Fetch failed http://user:secret@provider.example/epg?password=secret',
        },
    };
    const result = mapSourceWithChannelCountToApi(
        row as Parameters<typeof mapSourceWithChannelCountToApi>[0],
    );
    expect(result).toHaveProperty('lastRefreshError', expect.stringContaining('Fetch failed'));
    expect(JSON.stringify(result)).not.toContain('secret');
});

it('surfaces the independent guide error and warnings without changing playlist status', () => {
    const result = mapSourceWithChannelCountToApi(
        row({
            last_refresh_status: 'success',
            last_refresh_summary: {
                channelCount: 5,
                warnings: ['playlist'],
                epg: {
                    status: 'failed',
                    error: 'Guide http://u:secret@example.com/epg',
                    warnings: ['guide'],
                },
            },
        }),
    );
    expect(result.lastRefreshStatus).toBe('success');
    expect(result.lastRefreshError).toContain('Guide');
    expect(result.lastImportWarnings).toEqual(['playlist', 'guide']);
    expect(JSON.stringify(result)).not.toContain('secret');
});
