// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

import LiveTvOverlay from './LiveTvOverlay.svelte';
import { playerStore } from './playerStore.svelte';

const STATION = '7eeb26ce-026d-4911-b312-c7449d0c9399'; // backup group = station id
const FEED = '43d9a492-51ee-44be-802b-109361cd2cea'; // shown feed = media item id

// Prod 2026-10-21: the overlay asked /api/livetv/stations/<feed id>/programs and
// got 404 for every grouped channel: that route takes the STATION id, which is
// the watch page's playbackInfo.itemId. playerStore.itemId is the shown feed.
describe('LiveTvOverlay program fetch', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
        vi.stubGlobal('fetch', fetchMock);
        playerStore.itemId = FEED;
        playerStore.isLive = true;
        playerStore.playbackInfo = { itemId: STATION, internalId: FEED } as never;
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        playerStore.itemId = null;
        playerStore.isLive = false;
        playerStore.playbackInfo = null;
    });

    it('requests the schedule by station id, not by the shown feed id', async () => {
        render(LiveTvOverlay);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const urls = fetchMock.mock.calls.map(([u]) => String(u));
        expect(urls.some((u) => u.includes(`/api/livetv/stations/${STATION}/programs`))).toBe(true);
        expect(urls.some((u) => u.includes(`/stations/${FEED}/`))).toBe(false);
    });
});
