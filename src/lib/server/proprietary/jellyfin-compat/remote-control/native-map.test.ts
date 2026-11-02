// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin → device-command registry mapping for native Lumastra devices:
 * every Playstate / GeneralCommand / Play form, what a device announces as
 * SupportedCommands, and how reported state becomes a Jellyfin PlayState.
 */

import { describe, expect, it } from 'vitest';
import { DEVICE_COMMANDS, type DeviceNowPlaying } from '$lib/schemas/device-commands';
import {
    announcedCommands,
    generalCommandToRequest,
    jellyfinCapabilityView,
    nowPlayingToItem,
    nowPlayingToPlayState,
    playKindForDbType,
    playRequestToRequests,
    MAX_EXTRAPOLATION_SECONDS,
    playstateToRequest,
    usableCommands,
    type ResolvedItem,
} from './native-map';
import { PLAYSTATE_COMMANDS, type GeneralCommandData, type GeneralCommandType } from './protocol';

const cmd = (
    Name: GeneralCommandType,
    Arguments: Record<string, string> = {},
): GeneralCommandData => ({
    Name,
    ControllingUserId: 'u',
    Arguments,
});
const movie: ResolvedItem = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'movie' };
const track: ResolvedItem = { id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'track' };

/** Every request the mapping produces must be a valid registry request. */
function expectValid(result: ReturnType<typeof playstateToRequest>): void {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = DEVICE_COMMANDS[result.request.type].args.safeParse(result.request.args ?? {});
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
}

describe('Playstate → registry', () => {
    it.each([
        ['Pause', undefined, 'playback.pause', undefined],
        ['Unpause', undefined, 'playback.resume', undefined],
        ['PlayPause', undefined, 'playback.togglePause', undefined],
        ['Stop', undefined, 'playback.stop', undefined],
        ['NextTrack', undefined, 'playback.next', undefined],
        ['PreviousTrack', undefined, 'playback.previous', undefined],
        ['FastForward', undefined, 'playback.seekBy', { seconds: 30 }],
        ['Rewind', undefined, 'playback.seekBy', { seconds: -10 }],
        ['Seek', 12_345_000_000, 'playback.seekTo', { positionSeconds: 1234.5 }],
    ] as const)('%s -> %s', (command, ticks, type, args) => {
        const r = playstateToRequest(command, ticks);
        expect(r).toEqual({ ok: true, request: { type, ...(args ? { args } : {}) } });
        expectValid(r);
    });

    it('covers every Jellyfin playstate command', () => {
        for (const c of PLAYSTATE_COMMANDS) {
            expect(playstateToRequest(c, 0).ok, c).toBe(true);
        }
    });

    it('Seek needs a non-negative position', () => {
        expect(playstateToRequest('Seek', undefined)).toMatchObject({
            ok: false,
            reason: 'invalid',
        });
        expect(playstateToRequest('Seek', -1)).toMatchObject({ ok: false, reason: 'invalid' });
    });
});

describe('GeneralCommand → registry', () => {
    it('track selection: audio index, subtitle index, -1 switches subtitles off', () => {
        const audio = generalCommandToRequest(cmd('SetAudioStreamIndex', { Index: '2' }), []);
        expect(audio).toEqual({
            ok: true,
            request: { type: 'playback.setAudioTrack', args: { index: 2 } },
        });
        expectValid(audio);
        const sub = generalCommandToRequest(cmd('SetSubtitleStreamIndex', { index: '3' }), []);
        expect(sub).toEqual({
            ok: true,
            request: { type: 'playback.setSubtitleTrack', args: { index: 3 } },
        });
        const off = generalCommandToRequest(cmd('SetSubtitleStreamIndex', { Index: '-1' }), []);
        expect(off).toEqual({
            ok: true,
            request: { type: 'playback.setSubtitleTrack', args: { index: -1 } },
        });
        expectValid(off);
    });

    it('rejects a missing or malformed track index; a negative audio index is invalid', () => {
        expect(generalCommandToRequest(cmd('SetAudioStreamIndex'), [])).toMatchObject({
            ok: false,
            reason: 'invalid',
        });
        expect(
            generalCommandToRequest(cmd('SetSubtitleStreamIndex', { Index: 'x' }), []),
        ).toMatchObject({ ok: false, reason: 'invalid' });
        expect(
            generalCommandToRequest(cmd('SetAudioStreamIndex', { Index: '-1' }), []),
        ).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('ChannelUp / ChannelDown', () => {
        expect(generalCommandToRequest(cmd('ChannelUp'), [])).toEqual({
            ok: true,
            request: { type: 'livetv.channelUp' },
        });
        expect(generalCommandToRequest(cmd('ChannelDown'), [])).toEqual({
            ok: true,
            request: { type: 'livetv.channelDown' },
        });
    });

    it('DisplayMessage: text, header joined, default header dropped, limits enforced', () => {
        const plain = generalCommandToRequest(
            cmd('DisplayMessage', { Header: 'Message from Server', Text: 'Dinner is ready' }),
            [],
        );
        expect(plain).toEqual({
            ok: true,
            request: { type: 'ui.message', args: { text: 'Dinner is ready' } },
        });
        expectValid(plain);
        const headed = generalCommandToRequest(
            cmd('DisplayMessage', { Header: 'Mum', Text: 'Dinner' }),
            [],
        );
        expect(headed).toMatchObject({ request: { args: { text: 'Mum\nDinner' } } });
        expect(generalCommandToRequest(cmd('DisplayMessage', {}), [])).toMatchObject({
            ok: false,
            reason: 'invalid',
        });
        expect(
            generalCommandToRequest(cmd('DisplayMessage', { Text: 'x'.repeat(281) }), []),
        ).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('repeat and shuffle', () => {
        expect(
            generalCommandToRequest(cmd('SetRepeatMode', { RepeatMode: 'RepeatAll' }), []),
        ).toEqual({ ok: true, request: { type: 'playback.setRepeat', args: { mode: 'all' } } });
        expect(
            generalCommandToRequest(cmd('SetRepeatMode', { RepeatMode: 'RepeatNone' }), []),
        ).toMatchObject({ request: { args: { mode: 'off' } } });
        expect(
            generalCommandToRequest(cmd('SetRepeatMode', { RepeatMode: 'Loud' }), []),
        ).toMatchObject({ ok: false, reason: 'invalid' });
        expect(
            generalCommandToRequest(cmd('SetShuffleQueue', { ShuffleMode: 'Shuffle' }), []),
        ).toEqual({ ok: true, request: { type: 'playback.setShuffle', args: { on: true } } });
        expect(
            generalCommandToRequest(cmd('SetPlaybackOrder', { PlaybackOrder: 'Default' }), []),
        ).toMatchObject({ request: { args: { on: false } } });
        expect(
            generalCommandToRequest(cmd('SetShuffleQueue', { ShuffleMode: 'Sorted' }), []),
        ).toMatchObject({ request: { args: { on: false } } });
    });

    it('DisplayContent opens the detail screen; Play / PlayMediaSource play from the start', () => {
        const detail = generalCommandToRequest(cmd('DisplayContent'), [movie]);
        expect(detail).toEqual({
            ok: true,
            request: {
                type: 'media.play',
                args: { kind: 'movie', itemId: movie.id, mode: 'openDetail' },
            },
        });
        expectValid(detail);
        for (const name of ['Play', 'PlayMediaSource'] as const) {
            const r = generalCommandToRequest(cmd(name), [track]);
            expect(r).toEqual({
                ok: true,
                request: {
                    type: 'media.play',
                    args: { kind: 'track', itemId: track.id, mode: 'play', resume: false },
                },
            });
            expectValid(r);
        }
        expect(generalCommandToRequest(cmd('Play'), [])).toMatchObject({
            ok: false,
            reason: 'invalid',
        });
    });

    it('GeneralCommand Play passes StartPositionTicks as startSeconds', () => {
        const r = generalCommandToRequest(cmd('Play', { StartPositionTicks: '90000000' }), [movie]);
        expect(r).toMatchObject({
            ok: true,
            request: { args: { startSeconds: 9, resume: false } },
        });
        expectValid(r);
        expect(
            generalCommandToRequest(cmd('Play', { StartPositionTicks: '-5' }), [movie]),
        ).toMatchObject({ ok: false, reason: 'invalid' });
        const zero = generalCommandToRequest(cmd('Play', { StartPositionTicks: '0' }), [movie]);
        expect((zero as { request: { args: object } }).request.args).not.toHaveProperty(
            'startSeconds',
        );
    });

    it('PlayNext adds all items after the playing one', () => {
        const r = generalCommandToRequest(cmd('PlayNext'), [track, movie]);
        expect(r).toEqual({
            ok: true,
            request: {
                type: 'queue.add',
                args: { itemIds: [track.id, movie.id], position: 'next' },
            },
        });
        expectValid(r);
    });

    it.each([
        'VolumeUp',
        'Mute',
        'MoveUp',
        'GoHome',
        'SendString',
        'ToggleFullscreen',
        'SetVolume',
    ] as const)('%s is unsupported', (name) => {
        expect(generalCommandToRequest(cmd(name), [])).toMatchObject({
            ok: false,
            reason: 'unsupported',
        });
    });
});

describe('Play → registry', () => {
    const track2: ResolvedItem = { id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'track' };
    const requests = (r: ReturnType<typeof playRequestToRequests>) => (r.ok ? r.requests : r);

    it('PlayNow / PlayShuffle / PlayInstantMix of one item play it from the start', () => {
        for (const playCommand of ['PlayNow', 'PlayShuffle', 'PlayInstantMix'] as const) {
            const r = playRequestToRequests({ playCommand, items: [movie] });
            expect(r).toEqual({
                ok: true,
                requests: [
                    {
                        type: 'media.play',
                        args: { kind: 'movie', itemId: movie.id, mode: 'play', resume: false },
                    },
                ],
            });
        }
    });

    it('StartPositionTicks becomes startSeconds; 0 and absent start from the beginning', () => {
        const r = playRequestToRequests({
            playCommand: 'PlayNow',
            items: [movie],
            startPositionTicks: 90_000_000,
        });
        expect(r).toMatchObject({ requests: [{ args: { startSeconds: 9, resume: false } }] });
        const zero = playRequestToRequests({
            playCommand: 'PlayNow',
            items: [movie],
            startPositionTicks: 0,
        });
        expect((requests(zero) as { args: object }[])[0].args).not.toHaveProperty('startSeconds');
    });

    it('PlayNow of several tracks plays the one at StartIndex and queues the rest', () => {
        const r = playRequestToRequests({
            playCommand: 'PlayNow',
            items: [track, track2, movie],
            startIndex: 0,
        });
        // The movie follows: not a track, so the list is refused, not cut.
        expect(r).toMatchObject({ ok: false, reason: 'unsupported' });

        const ok = playRequestToRequests({
            playCommand: 'PlayNow',
            items: [movie, track, track2],
            startIndex: 1,
        });
        expect(ok).toEqual({
            ok: true,
            requests: [
                {
                    type: 'media.play',
                    args: { kind: 'track', itemId: track.id, mode: 'play', resume: false },
                },
                { type: 'queue.add', args: { itemIds: [track2.id], position: 'end' } },
            ],
        });
        for (const req of (ok as { requests: { type: 'media.play' | 'queue.add'; args: object }[] })
            .requests) {
            expect(DEVICE_COMMANDS[req.type].args.safeParse(req.args).success).toBe(true);
        }
    });

    it('PlayShuffle / PlayInstantMix of several items is unsupported, not one silent item', () => {
        for (const playCommand of ['PlayShuffle', 'PlayInstantMix'] as const) {
            expect(playRequestToRequests({ playCommand, items: [track, track2] })).toMatchObject({
                ok: false,
                reason: 'unsupported',
            });
        }
    });

    it('StartIndex picks the item; an index outside the list is invalid', () => {
        const r = playRequestToRequests({
            playCommand: 'PlayNow',
            items: [movie, track],
            startIndex: 1,
        });
        expect(r).toMatchObject({ requests: [{ args: { itemId: track.id, kind: 'track' } }] });
        expect(
            playRequestToRequests({ playCommand: 'PlayNow', items: [movie], startIndex: 3 }),
        ).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('PlayNext / PlayLast add every item to the queue', () => {
        const next = playRequestToRequests({ playCommand: 'PlayNext', items: [track, movie] });
        expect(next).toEqual({
            ok: true,
            requests: [
                {
                    type: 'queue.add',
                    args: { itemIds: [track.id, movie.id], position: 'next' },
                },
            ],
        });
        const last = playRequestToRequests({ playCommand: 'PlayLast', items: [track] });
        expect(last).toMatchObject({ requests: [{ args: { position: 'end' } }] });
        expect(playRequestToRequests({ playCommand: 'PlayNow', items: [] })).toMatchObject({
            ok: false,
            reason: 'invalid',
        });
    });

    it('item kinds from the database vocabulary', () => {
        expect(playKindForDbType('tv')).toBe('series');
        expect(playKindForDbType('Movie')).toBe('movie');
        expect(playKindForDbType('audio')).toBe('track');
        expect(playKindForDbType('album')).toBe('album');
        expect(playKindForDbType('season')).toBeNull();
        expect(playKindForDbType('book')).toBeNull();
        expect(playKindForDbType(null)).toBeNull();
    });
});

describe('capabilities → what the Jellyfin app sees', () => {
    it('announced commands keep only registry types', () => {
        expect(announcedCommands({ commands: { 'playback.pause': {}, 'tv.explode': {} } })).toEqual(
            ['playback.pause'],
        );
        expect(announcedCommands(undefined)).toEqual([]);
    });

    it('SupportedCommands and PlayableMediaTypes follow the announced commands', () => {
        const view = jellyfinCapabilityView([
            'playback.pause',
            'ui.message',
            'playback.setAudioTrack',
            'playback.setSubtitleTrack',
            'livetv.channelUp',
            'playback.setShuffle',
            'media.play',
            'queue.add',
        ]);
        expect(view.supportedCommands).toEqual([
            'DisplayMessage',
            'SetAudioStreamIndex',
            'SetSubtitleStreamIndex',
            'ChannelUp',
            'SetShuffleQueue',
            'SetPlaybackOrder',
            'Play',
            'PlayMediaSource',
            'DisplayContent',
            'PlayNext',
        ]);
        expect(view.playableMediaTypes).toEqual(['Video', 'Audio']);
        expect(view.controllable).toBe(true);
        const transportOnly = jellyfinCapabilityView(['playback.pause']);
        expect(transportOnly.supportedCommands).toEqual([]);
        expect(transportOnly.playableMediaTypes).toEqual([]);
        expect(transportOnly.controllable).toBe(true);
        expect(jellyfinCapabilityView([]).controllable).toBe(false);
    });

    it('an administrator who is not the owner may use only the admin commands', () => {
        const all = ['playback.pause', 'ui.message', 'playback.stop', 'media.play'] as const;
        expect(usableCommands(all, true)).toEqual(['ui.message', 'playback.stop']);
        expect(usableCommands(all, false)).toEqual([...all]);
    });
});

describe('reported state → PlayState / NowPlayingItem', () => {
    const np: DeviceNowPlaying = {
        kind: 'video',
        sessionId: 's1',
        title: 'The Film',
        positionSeconds: 100,
        durationMs: 5_400_000,
        paused: false,
        rate: 1,
        observedAt: '2026-10-16T20:00:00.000Z',
        availableCommands: [],
        video: {
            itemId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            mediaType: 'movie',
            audioTracks: [],
            audioIndex: 1,
            subtitleTracks: [],
            subtitleIndex: null,
            segments: [],
        },
    };
    const now = Date.parse('2026-10-16T20:00:10.000Z');

    it('extrapolates the position while playing and holds it while paused', () => {
        const playing = nowPlayingToPlayState(np, ['playback.seekTo'], now);
        expect(playing.PositionTicks).toBe(1_100_000_000);
        expect(playing.IsPaused).toBe(false);
        expect(playing.CanSeek).toBe(true);
        expect(playing.AudioStreamIndex).toBe(1);
        expect(playing.SubtitleStreamIndex).toBe(-1);
        const paused = nowPlayingToPlayState({ ...np, paused: true }, [], now);
        expect(paused.PositionTicks).toBe(1_000_000_000);
        expect(paused.IsPaused).toBe(true);
        expect(paused.CanSeek).toBe(false);
    });

    it('stops extrapolating when the last report is older than the report interval allows', () => {
        const stale = nowPlayingToPlayState(
            { ...np, positionSeconds: 1000, observedAt: new Date(now - 60_000).toISOString() },
            [],
            now,
        );
        // Frozen at the sample, not 60 s on.
        expect(stale.PositionTicks).toBe(1000 * 10_000_000);
        const edge = nowPlayingToPlayState(
            {
                ...np,
                positionSeconds: 1000,
                observedAt: new Date(now - MAX_EXTRAPOLATION_SECONDS * 1000).toISOString(),
            },
            [],
            now,
        );
        expect(edge.PositionTicks).toBe((1000 + MAX_EXTRAPOLATION_SECONDS) * 10_000_000);
    });

    it('never runs past the end; idle is an empty PlayState', () => {
        const end = nowPlayingToPlayState({ ...np, positionSeconds: 5395 }, [], now);
        expect(end.PositionTicks).toBe(5400 * 10_000_000);
        expect(nowPlayingToPlayState(null, ['playback.seekTo'], now)).toMatchObject({
            IsPaused: false,
            CanSeek: false,
        });
    });

    it('music repeat and shuffle show up', () => {
        const music: DeviceNowPlaying = {
            ...np,
            kind: 'music',
            video: undefined,
            music: {
                trackId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                repeat: 'all',
                shuffle: true,
            },
        };
        const ps = nowPlayingToPlayState(music, [], now);
        expect(ps.RepeatMode).toBe('RepeatAll');
        expect(ps.PlaybackOrder).toBe('Shuffle');
    });

    it('a minimal NowPlayingItem with a Guid id, type and runtime', () => {
        const item = nowPlayingToItem(np);
        expect(item).toMatchObject({
            Name: 'The Film',
            Id: 'aaaaaaaabbbb4ccc8dddeeeeeeeeeeee',
            Type: 'Movie',
            MediaType: 'Video',
            RunTimeTicks: 54_000_000_000,
        });
        const tv = nowPlayingToItem({
            ...np,
            kind: 'livetv',
            video: undefined,
            livetv: { stationId: 'not-a-guid', feedId: 'not-a-guid', name: 'News' },
        });
        expect(tv.Type).toBe('TvChannel');
        expect(tv.Id).toMatch(/^[0-9a-f]{32}$/);
    });
});
