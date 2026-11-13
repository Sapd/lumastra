// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Lumastra remote controlling a Jellyfin client (direction B): the pure
 * mapping from the device-command registry to the messages a Jellyfin client
 * understands (`Playstate`, `GeneralCommand`, `Play`), and from what the client
 * reported (`SupportedCommands`, `PlayableMediaTypes`) to registry capabilities.
 *
 * Capabilities (what a `jf:` device announces)
 *
 * | Jellyfin client reported                | Registry command                      |
 * | --------------------------------------- | ------------------------------------- |
 * | SupportsMediaControl                    | playback.pause / resume / togglePause / stop / seekTo / seekBy / next / previous |
 * | SupportsMediaControl + PlayableMediaTypes | media.play, queue.add               |
 * | SetAudioStreamIndex                     | playback.setAudioTrack                |
 * | SetSubtitleStreamIndex                  | playback.setSubtitleTrack             |
 * | DisplayMessage                          | ui.message (no buttons: actions 0)    |
 * | ChannelUp / ChannelDown                 | livetv.channelUp / livetv.channelDown |
 * | SetRepeatMode                           | playback.setRepeat                    |
 * | SetShuffleQueue or SetPlaybackOrder     | playback.setShuffle                   |
 *
 * Commands
 *
 * | Registry                    | Jellyfin message                                         |
 * | --------------------------- | -------------------------------------------------------- |
 * | playback.pause              | Playstate Pause                                          |
 * | playback.resume             | Playstate Unpause                                        |
 * | playback.togglePause        | Playstate PlayPause                                      |
 * | playback.stop               | Playstate Stop                                           |
 * | playback.next / previous    | Playstate NextTrack / PreviousTrack                      |
 * | playback.seekTo             | Playstate Seek {SeekPositionTicks}                       |
 * | playback.seekBy             | Playstate Seek at (current position + seconds)           |
 * | playback.setAudioTrack      | GeneralCommand SetAudioStreamIndex {Index}               |
 * | playback.setSubtitleTrack   | GeneralCommand SetSubtitleStreamIndex {Index} (-1 = off) |
 * | livetv.channelUp / Down     | GeneralCommand ChannelUp / ChannelDown                   |
 * | playback.setRepeat          | GeneralCommand SetRepeatMode {RepeatMode}                |
 * | playback.setShuffle         | GeneralCommand SetShuffleQueue {ShuffleMode} (else SetPlaybackOrder) |
 * | ui.message                  | GeneralCommand DisplayMessage {Header, Text}             |
 * | media.play (play)           | Play {PlayNow, ItemIds, StartPositionTicks}              |
 * | media.play (openDetail)     | GeneralCommand DisplayContent {ItemId, ItemType}         |
 * | queue.add                   | Play {PlayNext / PlayLast, ItemIds}                      |
 *
 * Everything else (party.join, livetv.tune, queue.remove/move/jumpTo/clear,
 * skipSegment, cancelAutoplay, setRate, setSleepTimer, `notBefore`) is
 * `device_unsupported`: Jellyfin has no counterpart.
 */

import {
    type DeviceCapabilities,
    type DeviceCommandRequest,
    type DeviceCommandType,
    type MediaPlayKind,
} from '$lib/schemas/device-commands';
import { playlistIdToUuid } from '../playlist-id';
import {
    outboundMessage,
    toWireGuid,
    type GeneralCommandData,
    type GeneralCommandType,
    type MediaType,
    type OutboundMessage,
    type PlayCommand,
    type PlayRequestData,
    type PlaystateCommand,
    type PlaystateRequestData,
} from './protocol';

const TICKS_PER_SECOND = 10_000_000;
const GUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Id prefix of a Jellyfin client in the device API; never a device session id (a UUID). */
export const JELLYFIN_TARGET_PREFIX = 'jf:';

export const isJellyfinTargetId = (id: string): boolean => id.startsWith(JELLYFIN_TARGET_PREFIX);
export const toTargetId = (remoteSessionId: string): string =>
    `${JELLYFIN_TARGET_PREFIX}${remoteSessionId}`;
export const fromTargetId = (id: string): string => id.slice(JELLYFIN_TARGET_PREFIX.length);

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface ReportedClient {
    supportedCommands: readonly GeneralCommandType[];
    playableMediaTypes: readonly MediaType[];
    supportsMediaControl: boolean;
}

const TRANSPORT: readonly DeviceCommandType[] = [
    'playback.pause',
    'playback.resume',
    'playback.togglePause',
    'playback.stop',
    'playback.seekTo',
    'playback.seekBy',
    'playback.next',
    'playback.previous',
];

const BY_GENERAL_COMMAND: Partial<Record<GeneralCommandType, DeviceCommandType>> = {
    SetAudioStreamIndex: 'playback.setAudioTrack',
    SetSubtitleStreamIndex: 'playback.setSubtitleTrack',
    DisplayMessage: 'ui.message',
    ChannelUp: 'livetv.channelUp',
    ChannelDown: 'livetv.channelDown',
    SetRepeatMode: 'playback.setRepeat',
    SetShuffleQueue: 'playback.setShuffle',
    SetPlaybackOrder: 'playback.setShuffle',
};

/** The registry commands a Jellyfin client carries out, as device capabilities. */
export function registryCapabilities(client: ReportedClient): DeviceCapabilities {
    const commands: DeviceCapabilities['commands'] = {};
    if (client.supportsMediaControl) {
        for (const t of TRANSPORT) commands[t] = {};
        if (client.playableMediaTypes.length > 0) {
            commands['media.play'] = {};
            commands['queue.add'] = {};
        }
    }
    for (const g of client.supportedCommands) {
        const t = BY_GENERAL_COMMAND[g];
        if (!t) continue;
        // Jellyfin shows a message with no buttons.
        commands[t] = t === 'ui.message' ? { maxLength: 280, actions: 0 } : {};
    }
    return { commands };
}

/** A display hint from the client application's name. */
export function deviceTypeForClient(client: string): 'tv' | 'mobile' | 'web' | 'unknown' {
    const c = client.toLowerCase();
    if (/\b(tv|tvos|kodi|roku|webos|tizen|fire|cast|theater)\b|android tv|apple tv/.test(c)) {
        return 'tv';
    }
    if (/web|browser/.test(c)) return 'web';
    if (/android|ios|iphone|ipad|swiftfin|findroid|streamyfin|finamp|mobile|jellyfin for/.test(c)) {
        return 'mobile';
    }
    return 'unknown';
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type OutboundMapResult =
    | { ok: true; message: OutboundMessage }
    | { ok: false; kind: 'device_unsupported' | 'invalid' | 'conflict'; message: string };

export interface OutboundContext {
    /** Jellyfin form (32 hex) of the sending user. */
    controllingUserId: string;
    /** What the client reported in `SupportedCommands`. */
    supportedCommands: readonly GeneralCommandType[];
    /** Where the client says it is, for relative seeks. Undefined = unknown. */
    positionSeconds?: number;
    /** Shown as the message header. */
    senderLabel: string;
}

const unsupported = (message: string): OutboundMapResult => ({
    ok: false,
    kind: 'device_unsupported',
    message,
});
const invalid = (message: string): OutboundMapResult => ({ ok: false, kind: 'invalid', message });

const playstate = (
    ctx: OutboundContext,
    Command: PlaystateCommand,
    seekPositionTicks?: number,
): OutboundMapResult => {
    const data: PlaystateRequestData = {
        Command,
        ControllingUserId: ctx.controllingUserId,
        ...(seekPositionTicks !== undefined ? { SeekPositionTicks: seekPositionTicks } : {}),
    };
    return { ok: true, message: outboundMessage('Playstate', data) };
};

const general = (
    ctx: OutboundContext,
    Name: GeneralCommandType,
    Arguments: Record<string, string> = {},
): OutboundMapResult => {
    const data: GeneralCommandData = { Name, ControllingUserId: ctx.controllingUserId, Arguments };
    return { ok: true, message: outboundMessage('GeneralCommand', data) };
};

/** `media.play` kind → Jellyfin `BaseItemKind` (for DisplayContent's ItemType). */
const ITEM_TYPE: Record<MediaPlayKind, string> = {
    movie: 'Movie',
    episode: 'Episode',
    series: 'Series',
    track: 'Audio',
    album: 'MusicAlbum',
    playlist: 'Playlist',
    artist: 'MusicArtist',
    audiobook: 'AudioBook',
};

/**
 * A registry item id as the wire GUID Jellyfin clients take: a catalog UUID
 * stays itself, a playlist's serial id becomes its encoded UUID. Null when the
 * id is neither.
 */
export function itemIdToWire(kind: MediaPlayKind | null, id: string): string | null {
    if (kind === 'playlist' || (kind === null && /^\d{1,10}$/.test(id))) {
        const serial = Number(id);
        return Number.isSafeInteger(serial) && serial > 0
            ? toWireGuid(playlistIdToUuid(serial))
            : null;
    }
    return GUID_RE.test(id) ? toWireGuid(id) : null;
}

function playMessage(
    ctx: OutboundContext,
    playCommand: PlayCommand,
    itemIds: string[],
    startPositionTicks?: number,
): OutboundMapResult {
    const data: PlayRequestData = {
        ItemIds: itemIds,
        PlayCommand: playCommand,
        ControllingUserId: ctx.controllingUserId,
        StartPositionTicks: startPositionTicks ?? null,
    };
    return { ok: true, message: outboundMessage('Play', data) };
}

/**
 * The wire item ids a request names, or null. `media.play` names one;
 * `queue.add` several. Used for the access check before anything is sent.
 */
export function requestItemIds(request: DeviceCommandRequest): string[] | null {
    const args = request.args ?? {};
    if (request.type === 'media.play') {
        const wire = itemIdToWire(args['kind'] as MediaPlayKind, String(args['itemId'] ?? ''));
        return wire ? [wire] : null;
    }
    if (request.type === 'queue.add') {
        const ids = Array.isArray(args['itemIds']) ? (args['itemIds'] as unknown[]) : [];
        const wire = ids.map((i) => itemIdToWire(null, String(i)));
        return wire.every((w): w is string => w !== null) ? (wire as string[]) : null;
    }
    return [];
}

/** One registry command as the Jellyfin message that carries it out. */
export function requestToJellyfin(
    request: DeviceCommandRequest,
    ctx: OutboundContext,
): OutboundMapResult {
    if (request.notBefore !== undefined) {
        return unsupported('Jellyfin clients cannot run a scheduled command');
    }
    const args = (request.args ?? {}) as Record<string, unknown>;
    switch (request.type) {
        case 'playback.pause':
            return playstate(ctx, 'Pause');
        case 'playback.resume':
            return playstate(ctx, 'Unpause');
        case 'playback.togglePause':
            return playstate(ctx, 'PlayPause');
        case 'playback.stop':
            return playstate(ctx, 'Stop');
        case 'playback.next':
            return playstate(ctx, 'NextTrack');
        case 'playback.previous':
            return playstate(ctx, 'PreviousTrack');
        case 'playback.seekTo':
            return playstate(
                ctx,
                'Seek',
                Math.round(Number(args['positionSeconds']) * TICKS_PER_SECOND),
            );
        case 'playback.seekBy': {
            if (ctx.positionSeconds === undefined) {
                return {
                    ok: false,
                    kind: 'conflict',
                    message: 'The client reports no playback position to skip from',
                };
            }
            const target = Math.max(0, ctx.positionSeconds + Number(args['seconds']));
            return playstate(ctx, 'Seek', Math.round(target * TICKS_PER_SECOND));
        }
        case 'playback.setAudioTrack':
            return general(ctx, 'SetAudioStreamIndex', { Index: String(args['index']) });
        case 'playback.setSubtitleTrack':
            return general(ctx, 'SetSubtitleStreamIndex', { Index: String(args['index']) });
        case 'livetv.channelUp':
            return general(ctx, 'ChannelUp');
        case 'livetv.channelDown':
            return general(ctx, 'ChannelDown');
        case 'playback.setRepeat': {
            const mode = { off: 'RepeatNone', one: 'RepeatOne', all: 'RepeatAll' }[
                String(args['mode'])
            ];
            return mode ? general(ctx, 'SetRepeatMode', { RepeatMode: mode }) : invalid('Bad mode');
        }
        case 'playback.setShuffle': {
            const on = args['on'] === true;
            return ctx.supportedCommands.includes('SetShuffleQueue')
                ? general(ctx, 'SetShuffleQueue', { ShuffleMode: on ? 'Shuffle' : 'Sorted' })
                : general(ctx, 'SetPlaybackOrder', { PlaybackOrder: on ? 'Shuffle' : 'Default' });
        }
        case 'ui.message': {
            const actions = Array.isArray(args['actions']) ? args['actions'] : [];
            if (actions.length > 0) {
                return unsupported('Jellyfin clients cannot show message buttons');
            }
            return general(ctx, 'DisplayMessage', {
                Header: ctx.senderLabel,
                Text: String(args['text']),
            });
        }
        case 'media.play': {
            const kind = args['kind'] as MediaPlayKind;
            const wire = itemIdToWire(kind, String(args['itemId']));
            if (!wire) return invalid('itemId is not an item id this client can open');
            if (args['mode'] === 'openDetail') {
                if (!ctx.supportedCommands.includes('DisplayContent')) {
                    return unsupported('This client cannot open a detail screen');
                }
                return general(ctx, 'DisplayContent', { ItemId: wire, ItemType: ITEM_TYPE[kind] });
            }
            const start =
                typeof args['startSeconds'] === 'number'
                    ? Math.round(args['startSeconds'] * TICKS_PER_SECOND)
                    : undefined;
            return playMessage(ctx, 'PlayNow', [wire], start);
        }
        case 'queue.add': {
            const wire = requestItemIds(request);
            if (!wire) return invalid('itemIds are not item ids this client can open');
            return playMessage(ctx, args['position'] === 'next' ? 'PlayNext' : 'PlayLast', wire);
        }
        default:
            return unsupported(`A Jellyfin client cannot carry out ${request.type}`);
    }
}
