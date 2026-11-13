// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Registry → Jellyfin messages (the Lumastra remote controlling a Jellyfin
 * client): every command both ways, the announced capabilities, and the
 * commands Jellyfin cannot carry out.
 */

import { describe, expect, it } from 'vitest';
import { DEVICE_COMMAND_TYPES, type DeviceCommandRequest } from '$lib/schemas/device-commands';
import {
    deviceTypeForClient,
    fromTargetId,
    isJellyfinTargetId,
    itemIdToWire,
    registryCapabilities,
    requestItemIds,
    requestToJellyfin,
    toTargetId,
    type OutboundContext,
} from './jellyfin-targets-map';
import type { GeneralCommandType } from './protocol';

const ctx = (over: Partial<OutboundContext> = {}): OutboundContext => ({
    controllingUserId: 'a'.repeat(32),
    supportedCommands: [],
    senderLabel: 'Message from Denis',
    ...over,
});
const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const WIRE = 'aaaaaaaabbbb4ccc8dddeeeeeeeeeeee';

function map(request: DeviceCommandRequest, over: Partial<OutboundContext> = {}) {
    const r = requestToJellyfin(request, ctx(over));
    if (!r.ok) throw new Error(`${r.kind}: ${r.message}`);
    return { type: r.message.MessageType, data: r.message.Data as Record<string, unknown> };
}

describe('registry -> Playstate', () => {
    it.each([
        ['playback.pause', 'Pause'],
        ['playback.resume', 'Unpause'],
        ['playback.togglePause', 'PlayPause'],
        ['playback.stop', 'Stop'],
        ['playback.next', 'NextTrack'],
        ['playback.previous', 'PreviousTrack'],
    ] as const)('%s -> Playstate %s', (type, command) => {
        const m = map({ type });
        expect(m.type).toBe('Playstate');
        expect(m.data).toMatchObject({ Command: command, ControllingUserId: 'a'.repeat(32) });
    });

    it('seekTo -> Seek in ticks', () => {
        expect(
            map({ type: 'playback.seekTo', args: { positionSeconds: 90.5 } }).data,
        ).toMatchObject({
            Command: 'Seek',
            SeekPositionTicks: 905_000_000,
        });
    });

    it('seekBy -> Seek at position + seconds, clamped at 0; without a position it is a conflict', () => {
        expect(
            map({ type: 'playback.seekBy', args: { seconds: 10 } }, { positionSeconds: 100 }).data,
        ).toMatchObject({ Command: 'Seek', SeekPositionTicks: 1_100_000_000 });
        expect(
            map({ type: 'playback.seekBy', args: { seconds: -50 } }, { positionSeconds: 20 }).data,
        ).toMatchObject({ SeekPositionTicks: 0 });
        expect(
            requestToJellyfin({ type: 'playback.seekBy', args: { seconds: 10 } }, ctx()),
        ).toMatchObject({ ok: false, kind: 'conflict' });
    });
});

describe('registry -> GeneralCommand', () => {
    it('tracks, channels, repeat', () => {
        expect(map({ type: 'playback.setAudioTrack', args: { index: 2 } })).toMatchObject({
            type: 'GeneralCommand',
            data: { Name: 'SetAudioStreamIndex', Arguments: { Index: '2' } },
        });
        expect(map({ type: 'playback.setSubtitleTrack', args: { index: -1 } }).data).toMatchObject({
            Name: 'SetSubtitleStreamIndex',
            Arguments: { Index: '-1' },
        });
        expect(map({ type: 'livetv.channelUp' }).data).toMatchObject({ Name: 'ChannelUp' });
        expect(map({ type: 'livetv.channelDown' }).data).toMatchObject({ Name: 'ChannelDown' });
        expect(map({ type: 'playback.setRepeat', args: { mode: 'one' } }).data).toMatchObject({
            Name: 'SetRepeatMode',
            Arguments: { RepeatMode: 'RepeatOne' },
        });
    });

    it('shuffle uses SetShuffleQueue, or SetPlaybackOrder when only that is supported', () => {
        expect(
            map(
                { type: 'playback.setShuffle', args: { on: true } },
                { supportedCommands: ['SetShuffleQueue'] },
            ).data,
        ).toMatchObject({ Name: 'SetShuffleQueue', Arguments: { ShuffleMode: 'Shuffle' } });
        expect(
            map(
                { type: 'playback.setShuffle', args: { on: false } },
                { supportedCommands: ['SetPlaybackOrder'] },
            ).data,
        ).toMatchObject({ Name: 'SetPlaybackOrder', Arguments: { PlaybackOrder: 'Default' } });
    });

    it('a message becomes DisplayMessage with the sender as header; buttons are unsupported', () => {
        expect(map({ type: 'ui.message', args: { text: 'Dinner' } }).data).toMatchObject({
            Name: 'DisplayMessage',
            Arguments: { Header: 'Message from Denis', Text: 'Dinner' },
        });
        expect(
            requestToJellyfin(
                { type: 'ui.message', args: { text: 'Ok?', actions: [{ id: 'y', label: 'Yes' }] } },
                ctx(),
            ),
        ).toMatchObject({ ok: false, kind: 'device_unsupported' });
    });
});

describe('registry -> Play', () => {
    it('media.play -> Play PlayNow with the wire id and start ticks', () => {
        const m = map({
            type: 'media.play',
            args: { kind: 'movie', itemId: ITEM, mode: 'play', startSeconds: 60 },
        });
        expect(m).toMatchObject({
            type: 'Play',
            data: { ItemIds: [WIRE], PlayCommand: 'PlayNow', StartPositionTicks: 600_000_000 },
        });
        expect(
            map({ type: 'media.play', args: { kind: 'movie', itemId: ITEM, mode: 'play' } }).data,
        ).toMatchObject({ StartPositionTicks: null });
    });

    it('a playlist serial id becomes the encoded playlist UUID', () => {
        const m = map({
            type: 'media.play',
            args: { kind: 'playlist', itemId: '42', mode: 'play' },
        });
        expect(m.data).toMatchObject({ ItemIds: ['00000000000040008000' + '00000000002a'] });
    });

    it('openDetail -> DisplayContent when the client supports it, else unsupported', () => {
        const request: DeviceCommandRequest = {
            type: 'media.play',
            args: { kind: 'album', itemId: ITEM, mode: 'openDetail' },
        };
        expect(map(request, { supportedCommands: ['DisplayContent'] }).data).toMatchObject({
            Name: 'DisplayContent',
            Arguments: { ItemId: WIRE, ItemType: 'MusicAlbum' },
        });
        expect(requestToJellyfin(request, ctx())).toMatchObject({
            ok: false,
            kind: 'device_unsupported',
        });
    });

    it('an item id that is no id is invalid', () => {
        expect(
            requestToJellyfin(
                { type: 'media.play', args: { kind: 'movie', itemId: 'tmdb:550', mode: 'play' } },
                ctx(),
            ),
        ).toMatchObject({ ok: false, kind: 'invalid' });
        expect(itemIdToWire('movie', 'x')).toBeNull();
        expect(itemIdToWire('playlist', '0')).toBeNull();
    });

    it('queue.add -> Play PlayNext / PlayLast', () => {
        expect(
            map({ type: 'queue.add', args: { itemIds: [ITEM], position: 'next' } }),
        ).toMatchObject({ type: 'Play', data: { PlayCommand: 'PlayNext', ItemIds: [WIRE] } });
        expect(
            map({ type: 'queue.add', args: { itemIds: [ITEM], position: 'end' } }).data,
        ).toMatchObject({ PlayCommand: 'PlayLast' });
    });

    it('lists the item ids a request names, for the access check', () => {
        expect(requestItemIds({ type: 'playback.pause' })).toEqual([]);
        expect(
            requestItemIds({ type: 'media.play', args: { kind: 'movie', itemId: ITEM } }),
        ).toEqual([WIRE]);
        expect(requestItemIds({ type: 'queue.add', args: { itemIds: [ITEM, 'nope'] } })).toBeNull();
    });
});

describe('what a Jellyfin client cannot do', () => {
    const unsupportedTypes = [
        'party.join',
        'livetv.tune',
        'playback.setRate',
        'playback.setSleepTimer',
        'playback.skipSegment',
        'playback.cancelAutoplay',
        'queue.remove',
        'queue.move',
        'queue.jumpTo',
        'queue.clear',
    ] as const;

    it.each(unsupportedTypes)('%s is device_unsupported', (type) => {
        expect(requestToJellyfin({ type }, ctx())).toMatchObject({
            ok: false,
            kind: 'device_unsupported',
        });
    });

    it('a scheduled command is device_unsupported', () => {
        expect(
            requestToJellyfin({ type: 'playback.stop', notBefore: '2099-01-01T00:00:00Z' }, ctx()),
        ).toMatchObject({ ok: false, kind: 'device_unsupported' });
    });

    it('every registry type is either mapped or deliberately unsupported', () => {
        const mapped = DEVICE_COMMAND_TYPES.filter((t) => !unsupportedTypes.includes(t as never));
        expect(mapped.length + unsupportedTypes.length).toBe(DEVICE_COMMAND_TYPES.length);
        // Every mapped type produces a message (given enough context) rather than falling through.
        const args: Record<string, Record<string, unknown>> = {
            'media.play': { kind: 'movie', itemId: ITEM, mode: 'play' },
            'queue.add': { itemIds: [ITEM], position: 'end' },
            'playback.seekBy': { seconds: 1 },
            'playback.seekTo': { positionSeconds: 1 },
            'playback.setAudioTrack': { index: 0 },
            'playback.setSubtitleTrack': { index: 0 },
            'playback.setRepeat': { mode: 'off' },
            'playback.setShuffle': { on: true },
            'ui.message': { text: 'x' },
        };
        for (const type of mapped) {
            const r = requestToJellyfin(
                { type, ...(args[type] ? { args: args[type] } : {}) },
                ctx({ positionSeconds: 5, supportedCommands: ['SetShuffleQueue'] }),
            );
            expect(r.ok, type).toBe(true);
        }
    });
});

describe('capabilities of a Jellyfin client', () => {
    it('media control gives transport; PlayableMediaTypes add play and queue', () => {
        const caps = registryCapabilities({
            supportsMediaControl: true,
            playableMediaTypes: ['Video'],
            supportedCommands: [],
        });
        expect(Object.keys(caps.commands).sort()).toEqual(
            [
                'media.play',
                'playback.next',
                'playback.pause',
                'playback.previous',
                'playback.resume',
                'playback.seekBy',
                'playback.seekTo',
                'playback.stop',
                'playback.togglePause',
                'queue.add',
            ].sort(),
        );
        const noPlay = registryCapabilities({
            supportsMediaControl: true,
            playableMediaTypes: [],
            supportedCommands: [],
        });
        expect(noPlay.commands).not.toHaveProperty('media.play');
        expect(
            registryCapabilities({
                supportsMediaControl: false,
                playableMediaTypes: ['Video'],
                supportedCommands: [],
            }).commands,
        ).toEqual({});
    });

    it('GeneralCommands the client lists map to registry commands; messages announce no buttons', () => {
        const supported: GeneralCommandType[] = [
            'DisplayMessage',
            'SetAudioStreamIndex',
            'SetSubtitleStreamIndex',
            'ChannelUp',
            'ChannelDown',
            'SetRepeatMode',
            'SetPlaybackOrder',
            'VolumeUp',
        ];
        const caps = registryCapabilities({
            supportsMediaControl: false,
            playableMediaTypes: [],
            supportedCommands: supported,
        });
        expect(Object.keys(caps.commands).sort()).toEqual(
            [
                'livetv.channelDown',
                'livetv.channelUp',
                'playback.setAudioTrack',
                'playback.setRepeat',
                'playback.setShuffle',
                'playback.setSubtitleTrack',
                'ui.message',
            ].sort(),
        );
        expect(caps.commands['ui.message']).toEqual({ maxLength: 280, actions: 0 });
    });

    it('device type hints and the id prefix', () => {
        expect(deviceTypeForClient('Jellyfin Android TV')).toBe('tv');
        expect(deviceTypeForClient('Jellyfin Web')).toBe('web');
        expect(deviceTypeForClient('Findroid')).toBe('mobile');
        expect(deviceTypeForClient('Swiftfin')).toBe('mobile');
        expect(deviceTypeForClient('Something')).toBe('unknown');
        expect(toTargetId('abc')).toBe('jf:abc');
        expect(isJellyfinTargetId('jf:abc')).toBe(true);
        expect(isJellyfinTargetId('11111111-1111-4111-8111-111111111111')).toBe(false);
        expect(fromTargetId('jf:abc')).toBe('abc');
    });
});
