// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { homeMusicSessions } from '$lib/api/home-active-sessions.fixture.js';
import { SessionsResponseSchema } from '$lib/schemas/api-playback-responses.js';
import LiveSessionSection from './LiveSessionSection.svelte';
import { buildPublicAuthor } from '$lib/shared/public-author.js';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({
    apiGet,
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
}));
vi.mock('$lib/utils/modal-utils', () => ({
    openMediaModal: vi.fn(),
    openAlbumModal: vi.fn(),
    openArtistModal: vi.fn(),
}));
vi.mock('$lib/api/watch-together', () => ({
    getPublicParties: vi.fn(async () => ({ data: { items: [] }, error: null })),
}));
afterEach(cleanup);

it('retains the SSR music cards and artwork after a live visibility refresh', async () => {
    const initial = SessionsResponseSchema.parse({
        sessions: homeMusicSessions(),
        cacheTimestamp: Date.now(),
    });
    const updated = homeMusicSessions();
    updated[0].playCurrentTime = 50;
    apiGet.mockImplementation(async (url: string, schema: z.ZodType) => ({
        data: schema.parse(
            url === '/api/home/active-sessions'
                ? JSON.parse(JSON.stringify({ sessions: updated, cacheTimestamp: Date.now() }))
                : {
                      // The former management endpoint returns only the viewer's compact row.
                      items: [
                          {
                              playbackSessionId: 'session-web',
                              mediaId: 'track-web',
                              kind: 'music',
                              status: 'ACTIVE',
                              positionMs: 50000,
                              durationMs: 200000,
                              title: updated[0].title,
                              seriesTitle: null,
                              seasonNumber: null,
                              episodeNumber: null,
                              mediaType: 'track',
                              device: { id: 'web', name: null, client: null },
                              clientName: null,
                              clientVersion: null,
                              userAgent: null,
                              user: buildPublicAuthor(updated[0].userId!, 'alice', 'internal'),
                          },
                      ],
                      page: { limit: 1000, offset: 0, hasMore: false },
                  },
        ),
        error: null,
    }));
    const { container } = render(LiveSessionSection, {
        props: {
            data: {
                user: { username: 'alice', userId: updated[0].userId, hasWatchPermission: true },
                sessions: { pollIntervalMs: 60_000 },
            },
            initialSessions: initial.sessions,
            initialSessionsCacheTimestamp: initial.cacheTimestamp,
        },
    });
    function assertMusicCards(): void {
        expect(container.querySelectorAll('[role="button"][tabindex="0"]')).toHaveLength(2);
        for (const session of updated) {
            expect(container.textContent).toContain(session.title);
            expect(container.textContent).toContain(session.artistName);
            expect(container.textContent).toContain(session.albumName);
            expect(
                container.querySelector(`img[src*="/media/${session.id}/images/poster"]`),
            ).not.toBeNull();
            expect(
                container
                    .querySelector(`img[alt="${session.username} avatar"]`)
                    ?.getAttribute('src'),
            ).toContain(session.userId);
        }
        expect(container.textContent).toContain('Next:');
        expect(container.textContent).toContain('Next Song');
        expect(container.textContent).toContain('MP3 320');
        expect(container.textContent).toContain('OPUS 320');
    }
    assertMusicCards();
    // Same handler used on a poll, without waiting for the real five-second interval.
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => {
        expect(
            container.querySelector('[data-testid="stream-progress-fill"]')?.getAttribute('style'),
        ).toContain('25%');
    });
    assertMusicCards();
    expect(apiGet).toHaveBeenCalledWith(
        '/api/home/active-sessions',
        SessionsResponseSchema,
        expect.anything(),
    );
});

it('retains programme reveal after a visibility refresh remeasures the title', async () => {
    const media = vi
        .spyOn(window, 'matchMedia')
        .mockImplementation((query) => ({ matches: query === '(hover: hover)' }) as MediaQueryList);
    try {
        const session = SessionsResponseSchema.parse({
            sessions: [
                {
                    __id: 'live-session',
                    id: 'station',
                    mediaItemId: 'station',
                    mediaType: 'tvchannel',
                    title: 'Channel HD',
                    username: 'alice',
                    liveTvProgramName: 'Bayer Leverkusen versus the opponent',
                },
            ],
        }).sessions[0];
        apiGet.mockImplementation(async (_url: string, schema: z.ZodType) => ({
            data: schema.parse({
                sessions: [
                    { ...session, liveTvProgramName: session.liveTvProgramName + ' updated' },
                ],
                cacheTimestamp: Date.now(),
            }),
            error: null,
        }));
        const { container } = render(LiveSessionSection, {
            props: {
                data: { user: { hasWatchPermission: true }, sessions: { pollIntervalMs: 60_000 } },
                initialSessions: [session],
                initialSessionsCacheTimestamp: Date.now(),
            },
        });
        const title = container.querySelector<HTMLElement>('p.stream-title')!;
        const card = title.closest<HTMLElement>('[role="button"]')!;
        Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 600 });
        Object.defineProperty(title.parentElement, 'clientWidth', {
            configurable: true,
            value: 200,
        });
        vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 400 } as DOMRect);
        await waitFor(() => {
            expect(title.classList.contains('is-long')).toBe(true);
        });
        await fireEvent.pointerMove(card.querySelector('.stream-artwork')!, { clientX: 390 });
        expect(title.style.transform).toBe('translateX(-400px)');
        document.dispatchEvent(new Event('visibilitychange'));
        await waitFor(() => {
            expect(title.textContent).toContain('updated');
        });
        await waitFor(() => {
            expect(title.style.getPropertyValue('--stream-overflow')).toBe('400px');
        });
        expect(title.style.transform).toBe('translateX(-400px)');
    } finally {
        cleanup();
        media.mockRestore();
    }
});
