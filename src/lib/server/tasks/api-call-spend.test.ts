// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { withApiCallSpend } from './api-call-spend.js';
import { countExternalCall } from '../utils/external-request-counter.js';

describe('withApiCallSpend', () => {
    it('spends the total as api_calls plus a per-host kind for each domain', async () => {
        const spend = vi.fn();
        const result = await withApiCallSpend({ spend }, async () => {
            countExternalCall('https://api.themoviedb.org/3/movie/550', 200);
            countExternalCall('https://api.themoviedb.org/3/movie/551', 200);
            countExternalCall('https://api.mdblist.com/tmdb/movie', 200);
            return { success: true };
        });

        expect(result).toEqual({ success: true });
        expect(spend).toHaveBeenCalledWith('api_calls', 3);
        expect(spend).toHaveBeenCalledWith('api_calls:api.themoviedb.org', 2);
        expect(spend).toHaveBeenCalledWith('api_calls:api.mdblist.com', 1);
    });

    it('spends per-host error and 429 counts separately, only when non-zero', async () => {
        const spend = vi.fn();
        await withApiCallSpend({ spend }, async () => {
            countExternalCall('https://api.themoviedb.org/a', 429);
            countExternalCall('https://api.themoviedb.org/b', 500);
            countExternalCall('https://api.themoviedb.org/c', 200);
            countExternalCall('https://musicbrainz.org/ws/2/x', null);
        });

        expect(spend).toHaveBeenCalledWith('api_calls:api.themoviedb.org', 3);
        expect(spend).toHaveBeenCalledWith('api_errors:api.themoviedb.org', 2);
        expect(spend).toHaveBeenCalledWith('api_429:api.themoviedb.org', 1);
        expect(spend).toHaveBeenCalledWith('api_errors:musicbrainz.org', 1);
        expect(spend).not.toHaveBeenCalledWith('api_429:musicbrainz.org', expect.anything());
    });

    it('does not spend when no external requests were counted', async () => {
        const spend = vi.fn();
        const result = await withApiCallSpend({ spend }, async () => 'noop');

        expect(result).toBe('noop');
        expect(spend).not.toHaveBeenCalled();
    });
});

it('never writes private or custom hosts into the new error keys', async () => {
    const spend = vi.fn();
    await withApiCallSpend({ spend }, async () => {
        for (const host of [
            '10.0.0.1',
            'jellyfin.internal',
            'custom-ai.example',
            'api.openai.com.evil',
        ]) {
            countExternalCall(`http://${host}/x`, 429);
            countExternalCall(`http://${host}/y`, null);
        }
        countExternalCall('https://api.openai.com/v1/embeddings', 429);
    });
    expect(spend.mock.calls.filter(([kind]) => /^api_(errors|429):/.test(kind))).toEqual([
        ['api_errors:api.openai.com', 1],
        ['api_429:api.openai.com', 1],
    ]);
});

it('nested task helpers spend once, including calls after the inner helper', async () => {
    const spend = vi.fn();
    await withApiCallSpend({ spend }, async () => {
        await withApiCallSpend({ spend }, async () =>
            countExternalCall('https://lrclib.net/api/get', 200),
        );
        countExternalCall('https://lrclib.net/api/get', 404);
    });
    expect(spend.mock.calls.filter(([kind]) => kind === 'api_calls')).toEqual([['api_calls', 2]]);
    expect(spend).not.toHaveBeenCalledWith('api_errors:lrclib.net', expect.anything());
});
