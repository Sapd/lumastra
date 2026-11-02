// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A failed recent-plays read is not "nothing has been played", the session's
 * codecs are labelled as the source file's, and a session the planner never
 * saw says its method is the app's claim.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
const nav = vi.hoisted(() => ({ url: new URL('http://localhost/admin/fix/why-transcode') }));
vi.mock('$lib/api/client.js', () => api);
vi.mock('$app/state', () => ({ page: nav }));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return { page: readable({ data: {}, url: nav.url }) };
});
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));

import Page from './+page.svelte';

const MEDIA = '77777777-7777-7777-7777-777777777701';

const SESSION = {
    sessionId: 's1',
    startedAt: '2026-10-06T10:00:00.000Z',
    username: 'kid',
    clientName: 'Apple TV',
    clientVersion: '1.0.1',
    playMethod: 'full_transcode',
    planReasons: [],
    planRecorded: false,
    videoCodec: 'hevc',
    audioCodec: 'eac3',
    container: 'mkv',
    resolution: null,
    bitrateKbps: null,
    transcodeCodec: 'h264',
    subtitleMethod: null,
    deliveryPath: null,
};

afterEach(() => cleanup());

describe('/admin/fix/why-transcode', () => {
    it('a failed recent-plays read is not "nothing has been played"', async () => {
        api.apiGet.mockResolvedValue({ data: undefined, error: 'boom', status: 500 });
        render(Page);
        await screen.findByText(m.admin_fix_playback_recent_failed());
        expect(screen.queryByText(m.admin_fix_playback_recent_empty())).toBeNull();
    });

    it('labels source codecs as the source and flags an unplanned session', async () => {
        api.apiGet.mockImplementation(async (url: unknown) =>
            String(url).includes('recent-plays')
                ? { data: { generatedAt: SESSION.startedAt, plays: [] }, error: null }
                : {
                      data: {
                          generatedAt: SESSION.startedAt,
                          mediaId: MEDIA,
                          mediaTitle: 'Film',
                          sourceStreams: [],
                          sessions: [SESSION],
                      },
                      error: null,
                  },
        );
        render(Page);
        const input = screen.getByPlaceholderText('00000000-0000-0000-0000-000000000000');
        await fireEvent.input(input, { target: { value: MEDIA } });
        await fireEvent.click(screen.getByRole('button', { name: m.admin_fix_playback_run() }));
        await screen.findByText(m.admin_fix_playback_no_plan());
        expect(screen.getByText(new RegExp(`^${m.admin_fix_playback_delivered()}:`))).toBeTruthy();
        expect(screen.getByText('h264')).toBeTruthy();
    });
});
