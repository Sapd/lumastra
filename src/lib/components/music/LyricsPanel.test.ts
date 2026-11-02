// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import LyricsPanel from './LyricsPanel.svelte';
const mocks = vi.hoisted(() => ({
    lyrics: vi.fn(),
    status: vi.fn(),
    setPlayer: (_state: Record<string, unknown>) => {},
}));
vi.mock('$lib/api/music', () => ({ getTrackLyrics: mocks.lyrics }));
vi.mock('$lib/stores/music-player.store', async () => {
    const { writable } = await import('svelte/store');
    const player = writable<Record<string, unknown>>({
        currentTrack: { id: 'song' },
        currentTimeMs: 0,
    });
    mocks.setPlayer = player.set;
    return {
        musicPlayerStore: {
            ...player,
            setLyricsStatus: mocks.status,
        },
    };
});
afterEach(cleanup);
it('distinguishes a network failure from absent lyrics and allows retry', async () => {
    mocks.lyrics.mockResolvedValueOnce({ error: 'Offline', status: 0 }).mockResolvedValueOnce({
        data: { lyrics: { plain: 'A line of lyrics' }, syncedLines: [] },
    });
    render(LyricsPanel);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No lyrics available')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('A line of lyrics')).toBeTruthy();
});
it('shows the interlude dots while the next sung line is far away', async () => {
    Element.prototype.scrollIntoView ??= vi.fn();
    mocks.setPlayer({ currentTrack: { id: 'intro-song' }, currentTimeMs: 3_000 });
    mocks.lyrics.mockResolvedValueOnce({
        data: {
            lyrics: {},
            syncedLines: [
                { startMs: 12_000, text: 'First words' },
                { startMs: 14_000, text: 'Second words' },
            ],
        },
    });
    const { container } = render(LyricsPanel);
    expect(await screen.findByText('First words')).toBeTruthy();
    expect(container.querySelector('[data-interlude]')).not.toBeNull();
    // Singing has started: the dots give way to the highlighted line.
    mocks.setPlayer({ currentTrack: { id: 'intro-song' }, currentTimeMs: 12_500 });
    await vi.waitFor(() => expect(container.querySelector('[data-interlude]')).toBeNull());
    expect(screen.getByText('First words').className).toContain('text-white');
});
it('keeps the outgoing lyrics in sync through the first half of a crossfade', async () => {
    Element.prototype.scrollIntoView ??= vi.fn();
    const lyricsFor: Record<string, unknown> = {
        old: {
            data: {
                lyrics: {},
                syncedLines: [
                    { startMs: 170_000, text: 'Old second-to-last' },
                    { startMs: 175_000, text: 'Old last line' },
                ],
            },
        },
        new: {
            data: {
                lyrics: {},
                syncedLines: [
                    { startMs: 1_000, text: 'New first line' },
                    { startMs: 9_000, text: 'New second line' },
                ],
            },
        },
    };
    mocks.lyrics.mockReset().mockImplementation((id: string) => Promise.resolve(lyricsFor[id]));
    mocks.setPlayer({ currentTrack: { id: 'old' }, currentTimeMs: 171_000 });
    render(LyricsPanel);
    expect((await screen.findByText('Old second-to-last')).className).toContain('text-white');

    // Fade start: the store promotes the incoming track at once and its clock
    // reads the incoming deck (intro end), while the old song is still the
    // one you hear — the outgoing deck's clock moves on in crossfadeOutgoing.
    mocks.setPlayer({
        currentTrack: { id: 'new' },
        currentTimeMs: 8_000,
        isCrossfading: true,
        crossfadeProgress: 0.1,
        crossfadeOutgoing: { trackId: 'old', timeMs: 175_500 },
    });
    await vi.waitFor(() =>
        expect(screen.getByText('Old last line').className).toContain('text-white'),
    );
    expect(screen.queryByText('Loading lyrics…')).toBeNull();
    // The incoming lyrics load in the background meanwhile.
    await vi.waitFor(() => expect(mocks.lyrics).toHaveBeenCalledWith('new', expect.anything()));
    expect(screen.queryByText('New first line')).toBeNull();

    // Past the midpoint the incoming song dominates: its lyrics take over at
    // its own position, with no loading flash.
    mocks.setPlayer({
        currentTrack: { id: 'new' },
        currentTimeMs: 9_500,
        isCrossfading: true,
        crossfadeProgress: 0.6,
        crossfadeOutgoing: { trackId: 'old', timeMs: 177_000 },
    });
    await vi.waitFor(() =>
        expect(screen.getByText('New second line').className).toContain('text-white'),
    );
    expect(screen.queryByText('Old last line')).toBeNull();
    expect(screen.queryByText('Loading lyrics…')).toBeNull();
    // The lyrics button reflects the playing (incoming) track only.
    expect(mocks.status).toHaveBeenLastCalledWith('available');
});

function synced(...lines: [number, string][]) {
    return {
        data: { lyrics: {}, syncedLines: lines.map(([startMs, text]) => ({ startMs, text })) },
    };
}

it('keeps the outgoing lyrics past the midpoint until the incoming ones have loaded', async () => {
    Element.prototype.scrollIntoView ??= vi.fn();
    let finishIncoming!: (v: unknown) => void;
    mocks.lyrics
        .mockReset()
        .mockImplementation((id: string) =>
            id === 'a'
                ? Promise.resolve(synced([100_000, 'A last line']))
                : new Promise((resolve) => (finishIncoming = resolve)),
        );
    mocks.setPlayer({ currentTrack: { id: 'a' }, currentTimeMs: 101_000 });
    render(LyricsPanel);
    expect(await screen.findByText('A last line')).toBeTruthy();

    const fade = { isCrossfading: true, crossfadeOutgoing: { trackId: 'a', timeMs: 102_000 } };
    mocks.setPlayer({
        currentTrack: { id: 'b' },
        currentTimeMs: 2_000,
        crossfadeProgress: 0.8,
        ...fade,
    });
    await vi.waitFor(() => expect(mocks.lyrics).toHaveBeenCalledWith('b', expect.anything()));
    // Slow incoming lyrics: no spinner, the outgoing song's lyrics stay.
    expect(screen.queryByText('Loading lyrics…')).toBeNull();
    expect(screen.getByText('A last line')).toBeTruthy();

    finishIncoming(synced([1_000, 'B first line']));
    expect(await screen.findByText('B first line')).toBeTruthy();
    expect(screen.queryByText('A last line')).toBeNull();
});

it('a track crossfading into itself follows the outgoing clock until the midpoint', async () => {
    Element.prototype.scrollIntoView ??= vi.fn();
    mocks.lyrics
        .mockReset()
        .mockResolvedValue(synced([1_000, 'Opening line'], [200_000, 'Closing line']));
    mocks.setPlayer({ currentTrack: { id: 'loop' }, currentTimeMs: 201_000 });
    render(LyricsPanel);
    expect((await screen.findByText('Closing line')).className).toContain('text-white');

    mocks.setPlayer({
        currentTrack: { id: 'loop' },
        currentTimeMs: 2_000,
        isCrossfading: true,
        crossfadeProgress: 0.2,
        crossfadeOutgoing: { trackId: 'loop', timeMs: 203_000 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Closing line').className).toContain('text-white');
    expect(screen.getByText('Opening line').className).not.toContain('text-white');
});

it('retries a track whose lyrics request threw synchronously', async () => {
    mocks.lyrics
        .mockReset()
        .mockImplementationOnce(() => {
            throw new Error('boom');
        })
        .mockResolvedValueOnce({
            data: { lyrics: { plain: 'Second try works' }, syncedLines: [] },
        });
    mocks.setPlayer({ currentTrack: { id: 'flaky' }, currentTimeMs: 0 });
    render(LyricsPanel);
    expect(await screen.findByRole('alert')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Second try works')).toBeTruthy();
});

it('cancels the lyrics request of a track skipped past before it loaded', async () => {
    const signals: Record<string, AbortSignal> = {};
    mocks.lyrics.mockReset().mockImplementation((id: string, signal: AbortSignal) => {
        signals[id] = signal;
        return new Promise(() => {});
    });
    mocks.setPlayer({ currentTrack: { id: 'one' }, currentTimeMs: 0 });
    render(LyricsPanel);
    await vi.waitFor(() => expect(signals.one).toBeDefined());
    mocks.setPlayer({ currentTrack: { id: 'two' }, currentTimeMs: 0 });
    await vi.waitFor(() => expect(signals.two).toBeDefined());
    expect(signals.one.aborted).toBe(true);
    expect(signals.two.aborted).toBe(false);
});
