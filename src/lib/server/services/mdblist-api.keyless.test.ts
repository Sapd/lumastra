// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MDBList is opt-in: a fresh install without MDBLIST_API_KEY must not contact
 * mdblist.com, not even for the public list JSON that needs no key. The egress
 * audit of 2026-10-01 caught the For You warm-up fetching three public lists at
 * first boot, before the setup wizard had run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const configMock = vi.hoisted(() => ({ config: { MDBLIST_API_KEY: '' } }));
vi.mock('$lib/server/config', () => configMock);

const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../utils/fetch-utils.js', () => ({ fetchWithTimeout }));

import { mdblistApi } from './mdblist-api.js';

describe('mdblistApi.getList without a key', () => {
    beforeEach(() => {
        fetchWithTimeout.mockReset();
        fetchWithTimeout.mockResolvedValue(
            new Response(JSON.stringify([{ id: 1, rank: 1, title: 'A', mediatype: 'movie' }]), {
                status: 200,
            }),
        );
    });

    it('makes no request and returns nothing when MDBLIST_API_KEY is unset', async () => {
        configMock.config.MDBLIST_API_KEY = '';

        await expect(
            mdblistApi.getList('linaspurinis/top-watched-movies-of-the-week'),
        ).resolves.toEqual([]);
        expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    it('fetches the public list once a key is configured', async () => {
        configMock.config.MDBLIST_API_KEY = 'k';

        await mdblistApi.getList('linaspurinis/top-watched-movies-of-the-week');
        expect(fetchWithTimeout).toHaveBeenCalledWith(
            'https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week/json/',
            expect.anything(),
        );
    });
});
