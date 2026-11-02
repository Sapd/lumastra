// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Active Streams — music format badge.
 *
 * Video sessions get a 1080p/4K badge; music sessions had no equivalent, so a
 * stream showed nothing about what was actually playing. These cases pin the
 * badge text rules: lossy codecs are qualified by bitrate, lossless ones only
 * by sample rate and only above CD quality.
 */

import componentSource from './LiveSessionSection.svelte?raw';
import { compile, parse } from 'svelte/compiler';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveSessionSection from './LiveSessionSection.svelte';
import { flushSync, type ComponentProps } from 'svelte';

/**
 * `StreamSession` is declared inside LiveSessionSection.svelte and is not
 * exported, so derive it from the component's own prop type rather than
 * re-declaring it here. The fixtures were typed `Record<string, unknown>`,
 * which is not assignable to the prop and let the shapes drift silently.
 */
type StreamSession = NonNullable<
    ComponentProps<typeof LiveSessionSection>['initialSessions']
>[number];

const navigate = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ goto: navigate }));

vi.mock('$lib/utils/modal-utils', () => ({
    openMediaModal: vi.fn(),
    openAlbumModal: vi.fn(),
    openArtistModal: vi.fn(),
}));

// The widget also polls public watch parties for lobby cards; keep that off
// the network (no server in this environment).
vi.mock('$lib/api/watch-together', () => ({
    getPublicParties: vi.fn(async () => ({ data: { items: [] }, error: null })),
}));

afterEach(cleanup);

const PAGE_DATA = {
    user: { hasWatchPermission: true, isAdmin: false, userId: 'u1', username: 'tester' },
    features: { sessionsDeviceInfoPublic: true },
    sessions: { pollIntervalMs: 60_000 },
};

function musicSession(overrides: Partial<StreamSession> = {}): StreamSession {
    return {
        __id: 'sess-1',
        id: 'track-1',
        mediaItemId: 'track-1',
        jellyfinId: '',
        title: 'Test Track',
        mediaType: 'track',
        username: 'tester',
        clientname: 'Lumastra Music',
        browsername: 'Music Player',
        artistName: 'Test Artist',
        albumName: 'Test Album',
        playMethod: 'direct',
        playIsPlaying: true,
        playCurrentTime: 30,
        playItemDuration: 200,
        ...overrides,
    };
}

function renderWithSession(session: StreamSession) {
    return render(LiveSessionSection, {
        props: {
            data: PAGE_DATA,
            initialSessions: [session],
            initialSessionsCacheTimestamp: Date.now(),
        },
    });
}

describe('LiveSessionSection music format badge', () => {
    it('qualifies a lossy codec with its bitrate in kbps', () => {
        const { container } = renderWithSession(
            musicSession({
                playOriginalAudioCodec: 'mp3',
                playOriginalAudioBitrate: 320_000,
                playAudioSampleRate: 44100,
            }),
        );
        expect(container.textContent).toContain('MP3 320');
    });

    it('shows a lossless codec bare at CD quality — its bitrate says nothing', () => {
        const { container } = renderWithSession(
            musicSession({
                playOriginalAudioCodec: 'flac',
                playOriginalAudioBitrate: 1_128_606,
                playAudioSampleRate: 44100,
            }),
        );
        expect(container.textContent).toContain('FLAC');
        expect(container.textContent).not.toContain('1128');
    });

    it('qualifies a lossless codec with its sample rate above 48kHz', () => {
        const { container } = renderWithSession(
            musicSession({
                playOriginalAudioCodec: 'flac',
                playOriginalAudioBitrate: 3_129_042,
                playAudioSampleRate: 96_000,
            }),
        );
        expect(container.textContent).toContain('FLAC 96kHz');
    });

    it('renders a fractional sample rate without truncating it', () => {
        const { container } = renderWithSession(
            musicSession({
                playOriginalAudioCodec: 'flac',
                playAudioSampleRate: 88_200,
            }),
        );
        expect(container.textContent).toContain('FLAC 88.2kHz');
    });

    it('falls back to the container when it names the codec and none was recorded', () => {
        const { container } = renderWithSession(
            musicSession({ playOriginalContainer: 'mp3', playOriginalAudioBitrate: 256_000 }),
        );
        expect(container.textContent).toContain('MP3 256');
    });

    it('does not label an ambiguous container as a codec', () => {
        // ffprobe reports the MP4 family as a comma-joined list; the payload is
        // AAC or ALAC, so "MOV" would be worse than no badge at all.
        const { container } = renderWithSession(
            musicSession({
                playOriginalContainer: 'mov,mp4,m4a,3gp,3g2,mj2',
                playOriginalAudioBitrate: 256_000,
            }),
        );
        expect(container.textContent).not.toContain('MOV');
        expect(container.querySelector('.bg-emerald-600\\/90')).toBeNull();
    });

    it('renders no badge for an unprobed track rather than an empty chip', () => {
        const { container } = renderWithSession(musicSession({}));
        expect(container.querySelector('.bg-emerald-600\\/90')).toBeNull();
    });

    it('leaves video sessions on the resolution badge', () => {
        const { container } = render(LiveSessionSection, {
            props: {
                data: PAGE_DATA,
                initialSessions: [
                    musicSession({
                        mediaType: 'movie',
                        playVideoWidth: 1920,
                        playVideoHeight: 1080,
                        playOriginalAudioCodec: 'flac',
                        playAudioSampleRate: 96_000,
                    }),
                ],
                initialSessionsCacheTimestamp: Date.now(),
            },
        });
        expect(container.textContent).toContain('1080p');
        expect(container.textContent).not.toContain('FLAC 96kHz');
    });
});

describe('LiveSessionSection audiobookshelf source badge', () => {
    // `sessionSource: 'audiobookshelf'` covers two very different lanes —
    // a book Lumastra is streaming through its own byte proxy, and a
    // listener using the AudiobookShelf app directly with Lumastra only
    // observing. `isReadOnly` is what tells them apart; the badge must name
    // whichever app is actually serving the bytes, not always the source
    // library.
    it('labels a Lumastra-proxied stream as Lumastra, not AudiobookShelf', () => {
        const { container } = renderWithSession(
            musicSession({
                mediaType: 'audiobook',
                sessionSource: 'audiobookshelf',
                isReadOnly: false,
            }),
        );
        expect(container.textContent).toContain('Lumastra');
        expect(container.textContent).not.toContain('AudiobookShelf');
    });

    it("treats a missing isReadOnly as Lumastra-served, matching isOwnSession's !isReadOnly check", () => {
        const { container } = renderWithSession(
            musicSession({
                mediaType: 'audiobook',
                sessionSource: 'audiobookshelf',
            }),
        );
        expect(container.textContent).toContain('Lumastra');
        expect(container.textContent).not.toContain('AudiobookShelf');
    });

    it('labels a direct AudiobookShelf listener as AudiobookShelf', () => {
        const { container } = renderWithSession(
            musicSession({
                mediaType: 'audiobook',
                sessionSource: 'audiobookshelf',
                isReadOnly: true,
            }),
        );
        expect(container.textContent).toContain('AudiobookShelf');
    });
});

describe('LiveSessionSection audiobook cover resolution', () => {
    // The server resolves catalog versus ABS cover routes and supplies the
    // revisioned primary descriptor; the component consumes it as-is.
    it('uses the catalog poster route when an internal Lumastra UUID is present', () => {
        const { container } = renderWithSession(
            musicSession({
                mediaType: 'audiobook',
                sessionSource: 'audiobookshelf',
                isReadOnly: false,
                externalIds: { internal: 'uuid-123' },
                images: {
                    primary: {
                        href: '/api/media/uuid-123/images/poster?v=cover-1',
                        variants: { card: '/api/media/uuid-123/images/poster?size=card&v=cover-1' },
                        revision: 'cover-1',
                        source: 'self',
                    },
                },
            }),
        );
        const src = container.querySelector('img')?.getAttribute('src');
        expect(src).toBe('/api/media/uuid-123/images/poster?size=card&v=cover-1');
        expect(src).toContain('uuid-123');
        expect(src).not.toContain('/api/image/audiobook/');
    });

    it('falls back to the ABS byte-proxy route when there is no internal id', () => {
        const { container } = renderWithSession(
            musicSession({
                mediaType: 'audiobook',
                sessionSource: 'audiobookshelf',
                isReadOnly: true,
                externalIds: undefined,
                images: {
                    primary: {
                        href: '/api/image/audiobook/abs-item-42?v=abs-cover-1',
                        revision: 'abs-cover-1',
                        source: 'provider',
                    },
                },
            }),
        );
        const src = container.querySelector('img')?.getAttribute('src');
        expect(src).toBe('/api/image/audiobook/abs-item-42?v=abs-cover-1');
        expect(src).toContain('/api/image/audiobook/abs-item-42');
    });

    it('uses the text title instead of requesting unavailable movie-style logo art', () => {
        const { container } = renderWithSession(
            musicSession({
                mediaType: 'audiobook',
                sessionSource: 'audiobookshelf',
                externalIds: { internal: 'uuid-123' },
            }),
        );

        // The logo endpoint redirects missing audiobook logo art to the popcorn
        // placeholder, which previously rendered as a tiny image in this slot.
        expect(container.querySelector('img.max-h-8')).toBeNull();
        expect(container.querySelector('.stream-title')?.textContent).toContain('Test Track');
    });
});

describe('LiveSessionSection watch party card', () => {
    const partyTag = {
        groupId: 'g1',
        code: 'MOVIE-7X3K',
        visibility: 'listed' as const,
        host: {
            userId: '11111111-1111-4111-8111-111111111111',
            displayName: 'anna',
            images: { primary: { href: '/avatar', revision: '0', source: 'self' as const } },
        },
        participantCount: 2,
        viewerIsParticipant: false,
        syncState: 'synced' as const,
    };
    const movie = (overrides: Partial<StreamSession>): StreamSession => ({
        ...musicSession(),
        id: 'movie-1',
        mediaItemId: 'movie-1',
        title: 'Shared Movie',
        mediaType: 'movie',
        ...overrides,
    });

    it('folds the participants of one party into a single card with a Join button', () => {
        const { container, getAllByText } = render(LiveSessionSection, {
            props: {
                data: PAGE_DATA,
                initialSessions: [
                    movie({
                        __id: 's-anna',
                        username: 'anna',
                        playSessionId: 'p1',
                        watchParty: { ...partyTag, isHost: true },
                    }),
                    movie({
                        __id: 's-ben',
                        username: 'ben',
                        playSessionId: 'p2',
                        watchParty: { ...partyTag, isHost: false, driftSeconds: 0.4 },
                    }),
                    movie({ __id: 's-solo', username: 'carl', playSessionId: 'p3' }),
                ],
                initialSessionsCacheTimestamp: Date.now(),
            },
        });
        expect(container.querySelectorAll('.party-card')).toHaveLength(1);
        expect(getAllByText(/Watching together · 2/)).toHaveLength(1);
        // Party card + the unrelated stream = 2 cards, not 3.
        expect(container.querySelectorAll('[role="button"][tabindex="0"]')).toHaveLength(2);
        expect(getAllByText('Join')).toHaveLength(1);
    });

    it('labels a party of one as a watch party, not "watching together · 1"', () => {
        const { queryByText, getByText } = render(LiveSessionSection, {
            props: {
                data: PAGE_DATA,
                initialSessions: [
                    movie({
                        __id: 's-anna',
                        username: 'anna',
                        watchParty: { ...partyTag, isHost: true },
                    }),
                ],
                initialSessionsCacheTimestamp: Date.now(),
            },
        });
        expect(queryByText(/Watching together/)).toBeNull();
        expect(getByText('Watch party')).toBeTruthy();
    });

    it('offers no Join button to a participant', () => {
        const { queryByText } = render(LiveSessionSection, {
            props: {
                data: PAGE_DATA,
                initialSessions: [
                    movie({
                        __id: 's-anna',
                        username: 'anna',
                        watchParty: { ...partyTag, isHost: true, viewerIsParticipant: true },
                    }),
                ],
                initialSessionsCacheTimestamp: Date.now(),
            },
        });
        expect(queryByText('Join')).toBeNull();
    });
});

describe('LiveSessionSection crossfade presentation', () => {
    it('keeps one playback bar mounted through the fade and restores the ordinary artwork on expiry', () => {
        vi.useFakeTimers();
        try {
            const { container } = renderWithSession(
                musicSession({
                    crossfade: {
                        role: 'outgoing',
                        otherTrack: { mediaId: 'track-2', title: 'Next Song' },
                        remainingMs: 4000,
                        durationMs: 8000,
                    },
                    nextTrack: { mediaId: 'track-2', title: 'Next Song' },
                }),
            );
            const bar = container.querySelector('[data-testid="stream-progress-fill"]');
            expect(bar).not.toBeNull();
            expect(bar?.classList.contains('crossfade-progress')).toBe(true);
            expect((bar as HTMLElement).style.width).toBe('15%');
            expect(container.querySelectorAll('[data-testid="stream-progress-fill"]')).toHaveLength(
                1,
            );
            expect(container.querySelector('.crossfade-cover-other')?.getAttribute('alt')).toBe(
                'Next Song',
            );
            expect(container.textContent).toContain('Crossfading into');
            expect(container.textContent).not.toContain('Next:');
            expect(container.querySelector('[data-testid="crossfade-indicator"] div')).toBeNull();
            vi.advanceTimersByTime(2000);
            flushSync();
            expect(container.querySelector('[data-testid="stream-progress-fill"]')).toBe(bar);
            expect((bar as HTMLElement).style.width).toBe('16%');
            vi.advanceTimersByTime(2200);
            flushSync();
            expect(container.querySelector('[data-testid="stream-progress-fill"]')).toBe(bar);
            expect(bar?.classList.contains('crossfade-progress')).toBe(false);
            expect(container.querySelector('.crossfade-cover-other')).toBeNull();
            expect(container.querySelector('[data-testid="crossfade-indicator"]')).toBeNull();
            expect(container.textContent).toContain('Next:');
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });
    it('shows the incoming cover in front and retains a zero-position playback bar', () => {
        const { container } = renderWithSession(
            musicSession({
                playCurrentTime: 0,
                crossfade: {
                    role: 'incoming',
                    otherTrack: { mediaId: 'track-2', title: 'Previous Song' },
                    remainingMs: 4000,
                    durationMs: 8000,
                },
            }),
        );
        expect(container.textContent).toContain('Crossfading from');
        expect(container.querySelector('.crossfade-cover-incoming')).not.toBeNull();
        expect(container.querySelector('.crossfade-cover-outgoing')?.getAttribute('alt')).toBe(
            'Previous Song',
        );
        const bar = container.querySelector('[data-testid="stream-progress-fill"]');
        expect(bar?.classList.contains('crossfade-progress')).toBe(true);
        expect((bar as HTMLElement).style.width).toBe('0%');
        const label = container.querySelector('[data-testid="crossfade-indicator"]');
        expect(container.querySelector(`[aria-describedby="${label?.id}"]`)).not.toBeNull();
    });
});

describe('Active Streams emitted presentation styles', () => {
    const source = componentSource;
    const emitted = compile(source, { generate: 'client', css: 'external' }).css?.code ?? '';
    const styleSource = `<style>${emitted.replace(/:where\(\.svelte-[\w-]+\)/g, '').replace(/\.svelte-[\w-]+/g, '')}</style>`;
    const stylesheet = parse(styleSource, { modern: true }).css;
    function declaration(selector: string, property: string): string | undefined {
        const rule = stylesheet?.children.find(
            (node) =>
                node.type === 'Rule' &&
                styleSource.slice(node.prelude.start, node.prelude.end).includes(selector),
        );
        if (rule?.type !== 'Rule') return undefined;
        const value = rule.block.children.find(
            (node) => node.type === 'Declaration' && node.property === property,
        );
        return value?.type === 'Declaration' ? value.value : undefined;
    }
    it('emits a gentle pulse and places the incoming artwork over the outgoing cover', () => {
        expect(declaration('.crossfade-progress', 'animation')).toMatch(
            /pulse-slow 4s ease-in-out infinite$/,
        );
        expect(declaration('.crossfade-cover-other', 'position')).toBe('absolute');
        expect(declaration('.crossfade-cover-other', 'aspect-ratio')).toBe('1');
        expect(declaration('.crossfade-cover-current', 'transform')).toContain('translateX(-14%)');
        expect(declaration('.crossfade-cover-incoming', 'transform')).toContain('translateX(14%)');
        expect(declaration('.crossfade-cover-incoming', 'z-index')).toBe('1');
    });
    it('preserves watch-party stacking and reduced-motion overrides', () => {
        expect(declaration('.party-card', 'box-shadow')).toContain('6px -6px');
        expect(declaration('.party-card.party-card-deep', 'box-shadow')).toContain('12px -12px');
        const reduced = stylesheet?.children.find(
            (node) =>
                node.type === 'Atrule' &&
                node.name === 'media' &&
                node.prelude.includes('prefers-reduced-motion'),
        );
        const rules =
            reduced?.type === 'Atrule'
                ? (reduced.block?.children.map((rule) => styleSource.slice(rule.start, rule.end)) ??
                  [])
                : [];
        expect(
            rules.some(
                (rule) => rule.includes('.crossfade-progress') && rule.includes('animation: none'),
            ),
        ).toBe(true);
        expect(
            rules.some(
                (rule) =>
                    rule.includes('.stream-title.is-long') &&
                    rule.includes('animation: none') &&
                    rule.includes('text-overflow: ellipsis'),
            ),
        ).toBe(true);
        expect(
            rules.some(
                (rule) => rule.includes('.stream-artwork img') && rule.includes('transition: none'),
            ),
        ).toBe(true);
    });
});

describe('LiveSessionSection Live TV card', () => {
    it('shows channel artwork and guide information and opens the station player', async () => {
        const stationId = '550e8400-e29b-41d4-a716-446655440000';
        const { container } = renderWithSession(
            musicSession({
                id: stationId,
                mediaItemId: stationId,
                mediaType: 'tvchannel',
                title: 'Channel HD',
                liveTvProgramName: 'News',
                liveTvNextProgramName: 'Weather',
                images: { primary: { href: '/channel-logo', revision: '1', source: 'self' } },
            }),
        );
        expect(container.textContent).toContain('Channel HD');
        expect(container.textContent).toContain('News');
        expect(container.textContent).toContain('Weather');
        expect(
            [...container.querySelectorAll('img')].some((img) => img.src.includes('/channel-logo')),
        ).toBe(true);
        expect(container.querySelector('img.max-h-8')).toBeNull();
        await fireEvent.click(container.querySelector('[role="button"]')!);
        expect(navigate).toHaveBeenCalledWith(expect.stringContaining(`/watch/${stationId}`));
    });
});

describe('LiveSessionSection whole-card title scrub', () => {
    it('pans from artwork and metadata using card width and resets on card exit', async () => {
        vi.useFakeTimers();
        const media = vi
            .spyOn(window, 'matchMedia')
            .mockImplementation(
                (query) => ({ matches: query === '(hover: hover)' }) as MediaQueryList,
            );
        try {
            const { container } = renderWithSession(musicSession());
            const title = container.querySelector<HTMLElement>('.stream-title')!;
            const viewport = title.parentElement!;
            const card = title.closest<HTMLElement>('[role="button"]')!;
            Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 600 });
            Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 200 });
            vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
                left: 100,
                width: 400,
            } as DOMRect);

            vi.advanceTimersByTime(20);
            flushSync();
            const artwork = card.querySelector<HTMLElement>('.stream-artwork')!;
            await fireEvent.pointerMove(artwork, { clientX: 300 });
            expect(title.style.transform).toBe('translateX(-200px)');
            await fireEvent.pointerMove(viewport, { clientX: 490 });
            expect(title.style.transform).toBe('translateX(-400px)');
            vi.advanceTimersByTime(2000);
            flushSync();
            vi.advanceTimersByTime(20);
            flushSync();
            expect(title.style.transform).toBe('translateX(-400px)');
            await fireEvent.pointerMove(card, { clientX: 110 });
            expect(title.style.transform).toBe('translateX(0px)');
            await fireEvent.pointerLeave(card);
            expect(title.style.transform).toBe('');
        } finally {
            cleanup();
            vi.useRealTimers();
            media.mockRestore();
        }
    });
});

describe('LiveSessionSection Live TV programme title scrub', () => {
    it('reveals current and next programme titles across the card and resets them on exit', async () => {
        const media = vi
            .spyOn(window, 'matchMedia')
            .mockImplementation(
                (query) => ({ matches: query === '(hover: hover)' }) as MediaQueryList,
            );
        try {
            const { container } = renderWithSession(
                musicSession({
                    mediaType: 'tvchannel',
                    liveTvProgramName: 'DFB-Pokal: Bayer Leverkusen - 1. FC Example',
                    liveTvNextProgramName: 'Another very long programme title',
                }),
            );
            const titles = [...container.querySelectorAll<HTMLElement>('p.stream-title')];
            expect(titles).toHaveLength(2);
            const card = titles[0].closest<HTMLElement>('[role="button"]')!;
            vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
                left: 100,
                width: 400,
            } as DOMRect);
            for (const title of titles) {
                Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 600 });
                Object.defineProperty(title.parentElement, 'clientWidth', {
                    configurable: true,
                    value: 200,
                });
            }
            await fireEvent.pointerMove(card.querySelector('.stream-artwork')!, { clientX: 490 });
            for (const title of titles) expect(title.style.transform).toBe('translateX(-400px)');
            await fireEvent.pointerLeave(card);
            for (const title of titles) expect(title.style.transform).toBe('');
        } finally {
            media.mockRestore();
        }
    });
});

describe('Live TV programme title accessibility', () => {
    it('measures both programme titles for the touch marquee and includes the programme in the card label', () => {
        vi.useFakeTimers();
        const media = vi
            .spyOn(window, 'matchMedia')
            .mockReturnValue({ matches: false } as MediaQueryList);
        try {
            const { container } = renderWithSession(
                musicSession({
                    mediaType: 'tvchannel',
                    liveTvProgramName: 'Bayer Leverkusen versus the opponent',
                    liveTvNextProgramName: 'A very long next programme name',
                }),
            );
            const titles = [...container.querySelectorAll<HTMLElement>('p.stream-title')];
            expect(titles).toHaveLength(2);
            for (const title of titles) {
                Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 600 });
                Object.defineProperty(title.parentElement, 'clientWidth', {
                    configurable: true,
                    value: 200,
                });
            }
            vi.advanceTimersByTime(20);
            flushSync();
            for (const title of titles) {
                expect(title.classList.contains('is-long')).toBe(true);
                expect(title.style.getPropertyValue('--stream-overflow')).toBe('400px');
            }
            expect(titles[0].closest('[role="button"]')?.getAttribute('aria-label')).toContain(
                'Bayer Leverkusen versus the opponent',
            );
        } finally {
            cleanup();
            vi.useRealTimers();
            media.mockRestore();
        }
    });

    it('leaves reduced-motion titles still when the pointer moves', async () => {
        const media = vi
            .spyOn(window, 'matchMedia')
            .mockReturnValue({ matches: true } as MediaQueryList);
        try {
            const { container } = renderWithSession(
                musicSession({ mediaType: 'tvchannel', liveTvProgramName: 'Long programme' }),
            );
            const title = container.querySelector<HTMLElement>('p.stream-title')!;
            Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 600 });
            Object.defineProperty(title.parentElement, 'clientWidth', {
                configurable: true,
                value: 200,
            });
            const card = title.closest<HTMLElement>('[role="button"]')!;
            vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
                left: 0,
                width: 400,
            } as DOMRect);
            await fireEvent.pointerMove(card, { clientX: 390 });
            expect(title.style.transform).toBe('');
        } finally {
            media.mockRestore();
        }
    });
});

describe('LiveSessionSection Live TV programme timing', () => {
    function channel(overrides: Partial<StreamSession> = {}): StreamSession {
        return musicSession({
            mediaType: 'tvchannel',
            title: 'Channel HD',
            playIsPlaying: undefined,
            playCurrentTime: undefined,
            playItemDuration: undefined,
            streamProgress: 25,
            liveTvProgramName: 'News',
            liveTvProgramStartTime: new Date(Date.now() - 15 * 60_000).toISOString(),
            liveTvProgramEndTime: new Date(Date.now() + 45 * 60_000).toISOString(),
            ...overrides,
        });
    }

    it('shows programme elapsed time and full length without implying a pause', () => {
        const { container, getByTestId } = renderWithSession(channel());
        expect(container.textContent).toContain('15:00');
        expect(container.textContent).toContain('1:00:00');
        expect(container.textContent).not.toContain('⏸️');
        const fill = getByTestId('stream-progress-fill');
        expect(fill.style.width).toBe('25%');
        expect(fill.classList.contains('animate-pulse-slow')).toBe(false);
    });

    it('advances the programme clock without remounting the bar', () => {
        vi.useFakeTimers();
        try {
            const { container, getByTestId } = renderWithSession(channel());
            const fill = getByTestId('stream-progress-fill');
            vi.advanceTimersByTime(2000);
            flushSync();
            expect(container.textContent).toContain('15:02');
            expect(getByTestId('stream-progress-fill')).toBe(fill);
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });

    it('uses the server clock even after the browser wall clock jumps', () => {
        vi.useFakeTimers();
        try {
            const { container } = renderWithSession(channel());
            vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
            vi.advanceTimersByTime(2000);
            flushSync();
            expect(container.textContent).toContain('15:02');
            expect(container.textContent).toContain('1:00:00');
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });

    it('shows zero elapsed at programme start and hides timing after programme end', () => {
        vi.useFakeTimers();
        try {
            const { container, queryByTestId } = renderWithSession(
                channel({
                    liveTvProgramStartTime: new Date(Date.now()).toISOString(),
                    liveTvProgramEndTime: new Date(Date.now() + 2000).toISOString(),
                }),
            );
            expect(container.textContent).toContain('0:02');
            expect(queryByTestId('stream-progress-fill')).not.toBeNull();
            vi.advanceTimersByTime(2000);
            flushSync();
            expect(queryByTestId('stream-progress-fill')).toBeNull();
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });

    it('retains an explicitly reported pause while showing the programme schedule', () => {
        const { container, getByTestId } = renderWithSession(channel({ playIsPlaying: false }));
        expect(container.textContent).toContain('⏸️');
        expect(container.textContent).toContain('1:00:00');
        expect(getByTestId('stream-progress-fill').classList.contains('animate-pulse-slow')).toBe(
            true,
        );
    });

    it.each([
        { liveTvProgramStartTime: undefined },
        { liveTvProgramStartTime: 'invalid' },
        { liveTvProgramEndTime: 'invalid' },
        {
            liveTvProgramStartTime: '2099-01-01T00:00:00Z',
            liveTvProgramEndTime: '2099-01-01T00:00:00Z',
        },
        {
            liveTvProgramStartTime: '2099-01-02T00:00:00Z',
            liveTvProgramEndTime: '2099-01-01T00:00:00Z',
        },
        { liveTvProgramEndTime: new Date(Date.now() - 60_000).toISOString() },
        { liveTvProgramStartTime: new Date(Date.now() + 60_000).toISOString() },
    ])(
        'omits unknown or stale programme timing instead of showing zero durations: %j',
        (overrides) => {
            const { container, queryByTestId } = renderWithSession(channel(overrides));
            expect(queryByTestId('stream-progress-fill')).toBeNull();
            expect(container.textContent).not.toMatch(/0:00\s*\/\s*0:00/);
        },
    );
});

describe('LiveSessionSection CarPlay context', () => {
    it.each([true, false])('shows the CarPlay badge only when connected (%s)', (isCarPlay) => {
        const rendered = renderWithSession(musicSession({ isCarPlay }));
        expect(rendered.queryByText('CarPlay') !== null).toBe(isCarPlay);
    });
    it('does not reveal CarPlay when device information is private', () => {
        const rendered = render(LiveSessionSection, {
            props: {
                data: {
                    ...PAGE_DATA,
                    user: { ...PAGE_DATA.user, hasWatchPermission: false },
                    features: { sessionsDeviceInfoPublic: false },
                },
                initialSessions: [musicSession({ isCarPlay: true })],
                initialSessionsCacheTimestamp: Date.now(),
            },
        });
        expect(rendered.queryByText('CarPlay')).toBeNull();
    });
});
