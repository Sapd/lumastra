// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin remote apps controlling a native Lumastra device (direction A):
 * the pure mapping between the Jellyfin vocabulary (`Playstate`,
 * `GeneralCommand`, `Play`) and the device-command registry
 * (`$lib/schemas/device-commands.ts`).
 *
 * No I/O. Item lookups (which kind is this id?) happen in the caller and come
 * in as {@link ResolvedItem}s, so every mapping here is unit-testable.
 *
 * Mapping tables
 * --------------
 *
 * Playstate (`POST /Sessions/{id}/Playing/{command}`)
 *
 * | Jellyfin                     | Registry                                      |
 * | ---------------------------- | --------------------------------------------- |
 * | Pause                        | playback.pause                                |
 * | Unpause                      | playback.resume                               |
 * | PlayPause                    | playback.togglePause                          |
 * | Stop                         | playback.stop                                 |
 * | Seek (SeekPositionTicks)     | playback.seekTo {positionSeconds}             |
 * | NextTrack / PreviousTrack    | playback.next / playback.previous             |
 * | FastForward / Rewind         | playback.seekBy {+30 / -10} (Jellyfin defaults) |
 *
 * GeneralCommand (`/Command`, `/Command/{name}`, `/Message`)
 *
 * | Jellyfin                                  | Registry                                  |
 * | ----------------------------------------- | ----------------------------------------- |
 * | SetAudioStreamIndex {Index}               | playback.setAudioTrack {index}            |
 * | SetSubtitleStreamIndex {Index}, -1 = off  | playback.setSubtitleTrack {index}         |
 * | ChannelUp / ChannelDown                   | livetv.channelUp / livetv.channelDown     |
 * | DisplayMessage {Header, Text}             | ui.message {text}                         |
 * | SetRepeatMode {RepeatMode}                | playback.setRepeat {mode}                 |
 * | SetShuffleQueue {ShuffleMode}             | playback.setShuffle {on}                  |
 * | SetPlaybackOrder {PlaybackOrder}          | playback.setShuffle {on}                  |
 * | DisplayContent {ItemId}                   | media.play {mode: openDetail}             |
 * | Play / PlayMediaSource {ItemId(s)}        | media.play                                |
 * | PlayNext {ItemIds}                        | queue.add {position: next}                |
 * | everything else (volume, keys, GoHome, …) | unsupported                               |
 *
 * Play (`POST /Sessions/{id}/Playing`)
 *
 * | Jellyfin                         | Registry                                                 |
 * | -------------------------------- | -------------------------------------------------------- |
 * | PlayNow                          | media.play of ItemIds[StartIndex ?? 0], then queue.add (end) of the tracks after it |
 * | PlayShuffle / PlayInstantMix     | media.play of the one item; several items: unsupported   |
 * | PlayNext / PlayLast              | queue.add {itemIds, position: next / end}                |
 * | StartPositionTicks               | startSeconds, resume false (absent = from the start); also for GeneralCommand Play |
 */

import {
    DEVICE_COMMANDS,
    type DeviceCapabilities,
    type DeviceCommandRequest,
    type DeviceCommandType,
    type DeviceNowPlaying,
    type MediaPlayKind,
} from '$lib/schemas/device-commands';
import { JELLYFIN_SERVER_ID } from '../constants';
import type { JellyfinBaseItemDto, JellyfinItemType, JellyfinSessionInfo } from '../types';
import type {
    GeneralCommandData,
    GeneralCommandType,
    MediaType,
    PlayCommand,
    PlaystateCommand,
} from './protocol';
import { toWireGuid } from './protocol';

const TICKS_PER_SECOND = 10_000_000;

/** Jellyfin's default skip lengths (web client): forward 30 s, back 10 s. */
export const FAST_FORWARD_SECONDS = 30;
export const REWIND_SECONDS = 10;

export type NativeMapError =
    | { ok: false; reason: 'unsupported'; message: string }
    | { ok: false; reason: 'invalid'; message: string };

export type NativeMapResult = { ok: true; request: DeviceCommandRequest } | NativeMapError;

const unsupported = (message: string): NativeMapError => ({
    ok: false,
    reason: 'unsupported',
    message,
});
const invalid = (message: string): NativeMapError => ({ ok: false, reason: 'invalid', message });

// ---------------------------------------------------------------------------
// Capabilities → what the Jellyfin app sees
// ---------------------------------------------------------------------------

/** Registry commands that surface as Jellyfin `SupportedCommands` entries. */
const COMMAND_TO_GENERAL: Partial<Record<DeviceCommandType, readonly GeneralCommandType[]>> = {
    'ui.message': ['DisplayMessage'],
    'playback.setAudioTrack': ['SetAudioStreamIndex'],
    'playback.setSubtitleTrack': ['SetSubtitleStreamIndex'],
    'livetv.channelUp': ['ChannelUp'],
    'livetv.channelDown': ['ChannelDown'],
    'playback.setRepeat': ['SetRepeatMode'],
    'playback.setShuffle': ['SetShuffleQueue', 'SetPlaybackOrder'],
    'media.play': ['Play', 'PlayMediaSource', 'DisplayContent'],
    'queue.add': ['PlayNext'],
};

/** The commands a device announced that are in the registry (unknown names dropped). */
export function announcedCommands(
    capabilities: DeviceCapabilities | undefined,
): DeviceCommandType[] {
    if (!capabilities) return [];
    return Object.keys(capabilities.commands).filter((c): c is DeviceCommandType =>
        Object.prototype.hasOwnProperty.call(DEVICE_COMMANDS, c),
    );
}

/**
 * Which of the announced commands `forAdmin` may use: an administrator who is
 * not the device's owner may only send what the registry marks `admin`.
 */
export function usableCommands(
    announced: readonly DeviceCommandType[],
    forAdmin: boolean,
): DeviceCommandType[] {
    if (!forAdmin) return [...announced];
    return announced.filter((c) => (DEVICE_COMMANDS[c] as { admin?: boolean }).admin === true);
}

export interface JellyfinCapabilityView {
    supportedCommands: GeneralCommandType[];
    playableMediaTypes: MediaType[];
    /** Any command at all: the app may show the device as a cast target. */
    controllable: boolean;
}

export function jellyfinCapabilityView(
    commands: readonly DeviceCommandType[],
): JellyfinCapabilityView {
    const supported: GeneralCommandType[] = [];
    for (const c of commands) {
        for (const g of COMMAND_TO_GENERAL[c] ?? []) if (!supported.includes(g)) supported.push(g);
    }
    return {
        supportedCommands: supported,
        playableMediaTypes: commands.includes('media.play') ? ['Video', 'Audio'] : [],
        controllable: commands.length > 0,
    };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** An item id as the registry names it, with the kind `media.play` needs. */
export interface ResolvedItem {
    /** Catalog id (dashed UUID), or the playlist's serial id as a string. */
    id: string;
    kind: MediaPlayKind;
}

/** `media_items.media_type` → `media.play` kind. Absent = not playable on a device. */
const ITEM_KIND_BY_DB_TYPE: Record<string, MediaPlayKind | undefined> = {
    movie: 'movie',
    episode: 'episode',
    tv: 'series',
    series: 'series',
    track: 'track',
    audio: 'track',
    music: 'track',
    album: 'album',
    artist: 'artist',
    audiobook: 'audiobook',
};

export function playKindForDbType(dbType: string | null | undefined): MediaPlayKind | null {
    return ITEM_KIND_BY_DB_TYPE[(dbType ?? '').toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Jellyfin → registry
// ---------------------------------------------------------------------------

export function playstateToRequest(
    command: PlaystateCommand,
    seekPositionTicks: number | undefined,
): NativeMapResult {
    switch (command) {
        case 'Pause':
            return ok('playback.pause');
        case 'Unpause':
            return ok('playback.resume');
        case 'PlayPause':
            return ok('playback.togglePause');
        case 'Stop':
            return ok('playback.stop');
        case 'NextTrack':
            return ok('playback.next');
        case 'PreviousTrack':
            return ok('playback.previous');
        case 'FastForward':
            return ok('playback.seekBy', { seconds: FAST_FORWARD_SECONDS });
        case 'Rewind':
            return ok('playback.seekBy', { seconds: -REWIND_SECONDS });
        case 'Seek': {
            if (seekPositionTicks === undefined || seekPositionTicks < 0) {
                return invalid('seekPositionTicks is required for Seek');
            }
            return ok('playback.seekTo', { positionSeconds: seekPositionTicks / TICKS_PER_SECOND });
        }
    }
}

function ok(type: DeviceCommandType, args?: Record<string, unknown>): NativeMapResult {
    return { ok: true, request: { type, ...(args ? { args } : {}) } };
}

/** Case-insensitive `Arguments` lookup (Jellyfin's dictionary is case-insensitive). */
function arg(command: GeneralCommandData, name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [k, v] of Object.entries(command.Arguments)) {
        if (k.toLowerCase() === wanted) return v;
    }
    return undefined;
}

const REPEAT_MODES: Record<string, 'off' | 'one' | 'all'> = {
    repeatnone: 'off',
    repeatone: 'one',
    repeatall: 'all',
};

/**
 * One `GeneralCommand`. `items` are the already resolved ids of an
 * item-carrying command (`DisplayContent`, `Play`, `PlayMediaSource`,
 * `PlayNext`); empty for the others.
 */
export function generalCommandToRequest(
    command: GeneralCommandData,
    items: readonly ResolvedItem[],
): NativeMapResult {
    switch (command.Name) {
        case 'SetAudioStreamIndex':
        case 'SetSubtitleStreamIndex': {
            const raw = arg(command, 'Index');
            const index = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
            if (!Number.isInteger(index)) return invalid('Arguments.Index must be an integer');
            if (command.Name === 'SetAudioStreamIndex') {
                if (index < 0) return invalid('Arguments.Index must not be negative');
                return ok('playback.setAudioTrack', { index });
            }
            return ok('playback.setSubtitleTrack', { index: index < 0 ? -1 : index });
        }
        case 'ChannelUp':
            return ok('livetv.channelUp');
        case 'ChannelDown':
            return ok('livetv.channelDown');
        case 'DisplayMessage': {
            const text = arg(command, 'Text');
            if (!text || !text.trim()) return invalid('Arguments.Text is required');
            const header = arg(command, 'Header')?.trim();
            // "Message from Server" is what Jellyfin substitutes for a blank header.
            const withHeader = header && header !== 'Message from Server';
            const parsed = DEVICE_COMMANDS['ui.message'].args.safeParse({
                text: withHeader ? `${header}\n${text}` : text,
            });
            if (!parsed.success) {
                return invalid(
                    'The message is longer than 280 characters or has invisible characters',
                );
            }
            return ok('ui.message', parsed.data as Record<string, unknown>);
        }
        case 'SetRepeatMode': {
            const mode = REPEAT_MODES[(arg(command, 'RepeatMode') ?? '').toLowerCase()];
            if (!mode)
                return invalid('Arguments.RepeatMode must be RepeatNone, RepeatOne or RepeatAll');
            return ok('playback.setRepeat', { mode });
        }
        case 'SetShuffleQueue':
        case 'SetPlaybackOrder': {
            const raw = (
                arg(
                    command,
                    command.Name === 'SetShuffleQueue' ? 'ShuffleMode' : 'PlaybackOrder',
                ) ?? ''
            ).toLowerCase();
            if (raw !== 'shuffle' && raw !== 'sorted' && raw !== 'default') {
                return invalid('Arguments must name Shuffle or Sorted/Default');
            }
            return ok('playback.setShuffle', { on: raw === 'shuffle' });
        }
        case 'DisplayContent': {
            const item = items[0];
            if (!item) return invalid('Arguments.ItemId is required');
            return ok('media.play', { kind: item.kind, itemId: item.id, mode: 'openDetail' });
        }
        case 'Play':
        case 'PlayMediaSource': {
            const item = items[0];
            if (!item) return invalid('Arguments.ItemId(s) is required');
            const rawTicks = arg(command, 'StartPositionTicks');
            const ticks = rawTicks === undefined || rawTicks.trim() === '' ? 0 : Number(rawTicks);
            if (!Number.isFinite(ticks) || ticks < 0) {
                return invalid('Arguments.StartPositionTicks must not be negative');
            }
            return ok('media.play', {
                kind: item.kind,
                itemId: item.id,
                mode: 'play',
                resume: false,
                ...(ticks > 0 ? { startSeconds: ticks / TICKS_PER_SECOND } : {}),
            });
        }
        case 'PlayNext': {
            if (items.length === 0) return invalid('Arguments.ItemIds is required');
            return ok('queue.add', { itemIds: items.map((i) => i.id), position: 'next' });
        }
        default:
            return unsupported(`${command.Name} is not supported by this device`);
    }
}

export interface PlayInput {
    playCommand: PlayCommand;
    items: readonly ResolvedItem[];
    startIndex?: number;
    startPositionTicks?: number;
}

export type NativePlayResult = { ok: true; requests: DeviceCommandRequest[] } | NativeMapError;

/**
 * `POST /Sessions/{id}/Playing`, as the registry commands that carry it out, in
 * the order to send them.
 *
 * - PlayNext / PlayLast: one `queue.add` of every item.
 * - PlayNow with several items: `media.play` of the item at `startIndex`
 *   (default 0), then `queue.add` (end) of the items after it. The queue only
 *   takes tracks, so a list whose followers are not all tracks is unsupported
 *   rather than silently cut to one item.
 * - PlayShuffle / PlayInstantMix with several items: unsupported (the device
 *   cannot shuffle or mix; playing one item would pass for success).
 */
export function playRequestToRequests(input: PlayInput): NativePlayResult {
    const { playCommand, items } = input;
    if (items.length === 0) return invalid('itemIds must name at least one item');
    if (playCommand === 'PlayNext' || playCommand === 'PlayLast') {
        return {
            ok: true,
            requests: [
                {
                    type: 'queue.add',
                    args: {
                        itemIds: items.map((i) => i.id),
                        position: playCommand === 'PlayNext' ? 'next' : 'end',
                    },
                },
            ],
        };
    }
    if (items.length > 1 && (playCommand === 'PlayShuffle' || playCommand === 'PlayInstantMix')) {
        return unsupported(`${playCommand} of several items is not supported by this device`);
    }
    const index = input.startIndex ?? 0;
    const item = items[index];
    if (!item) return invalid('startIndex is outside itemIds');
    const ticks = input.startPositionTicks;
    const args: Record<string, unknown> = {
        kind: item.kind,
        itemId: item.id,
        mode: 'play',
        resume: false,
    };
    if (ticks !== undefined && ticks > 0) args.startSeconds = ticks / TICKS_PER_SECOND;
    const requests: DeviceCommandRequest[] = [{ type: 'media.play', args }];
    const followers = items.slice(index + 1);
    if (followers.length > 0) {
        if (followers.some((f) => f.kind !== 'track')) {
            return unsupported('This device plays one item at a time unless the rest are tracks');
        }
        requests.push({
            type: 'queue.add',
            args: { itemIds: followers.map((f) => f.id), position: 'end' },
        });
    }
    return { ok: true, requests };
}

// ---------------------------------------------------------------------------
// Registry → Jellyfin session view
// ---------------------------------------------------------------------------

/** A deterministic GUID for an id that is not one (a Live TV channel, a book id, …). */
function asWireGuid(id: string): string {
    const hex = id.replace(/-/g, '').toLowerCase();
    if (/^[0-9a-f]{32}$/.test(hex)) return hex;
    let h = 0n;
    for (const ch of id) h = (h * 131n + BigInt(ch.codePointAt(0) ?? 0)) % (1n << 128n);
    return h.toString(16).padStart(32, '0');
}

/** The id the `NowPlayingItem` carries: the catalog id inside the kind's block. */
function nowPlayingItemId(np: DeviceNowPlaying): string {
    if (np.kind === 'video') return np.video?.itemId ?? np.sessionId;
    if (np.kind === 'music') return np.music?.trackId ?? np.sessionId;
    if (np.kind === 'audiobook') return np.audiobook?.bookId ?? np.sessionId;
    return np.livetv?.stationId ?? np.sessionId;
}

const JELLYFIN_TYPE_BY_KIND: Record<DeviceNowPlaying['kind'], JellyfinItemType> = {
    video: 'Video',
    livetv: 'TvChannel',
    music: 'Audio',
    audiobook: 'Audio',
};

/**
 * The state a device reported, as a minimal `NowPlayingItem` (title, id, type,
 * runtime). The device state carries no artwork or metadata ids, so the item is
 * what a remote needs to show "what is playing", not a full BaseItemDto.
 */
export function nowPlayingToItem(np: DeviceNowPlaying): JellyfinBaseItemDto {
    const video = np.video;
    let type = JELLYFIN_TYPE_BY_KIND[np.kind];
    if (video?.mediaType) {
        const t = video.mediaType.toLowerCase();
        if (t === 'movie') type = 'Movie';
        else if (t === 'episode') type = 'Episode';
    }
    return {
        Name: np.title,
        Id: asWireGuid(nowPlayingItemId(np)),
        ServerId: JELLYFIN_SERVER_ID,
        Type: type,
        MediaType: np.kind === 'music' || np.kind === 'audiobook' ? 'Audio' : 'Video',
        IsFolder: false,
        ...(np.durationMs !== undefined
            ? { RunTimeTicks: Math.round((np.durationMs / 1000) * TICKS_PER_SECOND) }
            : {}),
        ...(np.subtitle ? { Overview: np.subtitle } : {}),
        ...(np.music?.artist ? { Artists: [np.music.artist] } : {}),
        ...(np.music?.album ? { Album: np.music.album } : {}),
        ...(video?.seriesId ? { SeriesId: toWireGuid(video.seriesId) } : {}),
        ...(video?.seasonNumber !== undefined ? { ParentIndexNumber: video.seasonNumber } : {}),
        ...(video?.episodeNumber !== undefined ? { IndexNumber: video.episodeNumber } : {}),
    };
}

/** Devices report every ~10 s while playing; past this the sample is no longer extended. */
export const MAX_EXTRAPOLATION_SECONDS = 30;

const REPEAT_TO_JELLYFIN = { off: 'RepeatNone', one: 'RepeatOne', all: 'RepeatAll' } as const;

/**
 * The `PlayState` of a native session. Position is extrapolated from the
 * sample while playing (up to {@link MAX_EXTRAPOLATION_SECONDS} after it was
 * taken, never past the duration), as the state doc tells remotes to do.
 */
export function nowPlayingToPlayState(
    np: DeviceNowPlaying | null,
    commands: readonly DeviceCommandType[],
    now = Date.now(),
): JellyfinSessionInfo['PlayState'] {
    const base: JellyfinSessionInfo['PlayState'] = {
        IsPaused: false,
        IsMuted: false,
        CanSeek: commands.includes('playback.seekTo'),
        RepeatMode: 'RepeatNone',
        PlaybackOrder: 'Default',
    };
    if (!np) return { ...base, CanSeek: false };
    let position = np.positionSeconds;
    if (position !== undefined && !np.paused && np.observedAt) {
        const elapsed = (now - Date.parse(np.observedAt)) / 1000;
        // A report older than this means the device stopped reporting: a position
        // that keeps running would be a guess about a silent client.
        if (Number.isFinite(elapsed) && elapsed > 0 && elapsed <= MAX_EXTRAPOLATION_SECONDS) {
            position += elapsed * (np.rate || 1);
            if (np.durationMs !== undefined) position = Math.min(position, np.durationMs / 1000);
        }
    }
    return {
        ...base,
        IsPaused: np.paused,
        ...(position !== undefined
            ? { PositionTicks: Math.round(position * TICKS_PER_SECOND) }
            : {}),
        RepeatMode: np.music?.repeat ? REPEAT_TO_JELLYFIN[np.music.repeat] : 'RepeatNone',
        PlaybackOrder: np.music?.shuffle ? 'Shuffle' : 'Default',
        ...(np.video?.audioIndex !== undefined && np.video.audioIndex !== null
            ? { AudioStreamIndex: np.video.audioIndex }
            : {}),
        ...(np.video?.subtitleIndex !== undefined
            ? { SubtitleStreamIndex: np.video.subtitleIndex ?? -1 }
            : {}),
    };
}
