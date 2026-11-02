// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin remote-control wire protocol: the enums SessionController binds,
 * and the WebSocket messages SessionManager sends (`Play`, `Playstate`,
 * `GeneralCommand`, plus the keep-alive pair).
 *
 * Pure — no I/O — so validation is unit-testable without Valkey or a socket.
 * Every enum list matches jellyfin-sdk-kotlin's OpenAPI: the SDK decodes these
 * into Kotlin enums and fails the whole message on an unknown value, so
 * nothing outside these lists may ever reach a client.
 */

import { randomUUID } from 'node:crypto';

export const PLAY_COMMANDS = [
    'PlayNow',
    'PlayNext',
    'PlayLast',
    'PlayInstantMix',
    'PlayShuffle',
] as const;
export type PlayCommand = (typeof PLAY_COMMANDS)[number];

export const PLAYSTATE_COMMANDS = [
    'Stop',
    'Pause',
    'Unpause',
    'NextTrack',
    'PreviousTrack',
    'Seek',
    'Rewind',
    'FastForward',
    'PlayPause',
] as const;
export type PlaystateCommand = (typeof PLAYSTATE_COMMANDS)[number];

export const GENERAL_COMMAND_TYPES = [
    'MoveUp',
    'MoveDown',
    'MoveLeft',
    'MoveRight',
    'PageUp',
    'PageDown',
    'PreviousLetter',
    'NextLetter',
    'ToggleOsd',
    'ToggleContextMenu',
    'Select',
    'Back',
    'TakeScreenshot',
    'SendKey',
    'SendString',
    'GoHome',
    'GoToSettings',
    'VolumeUp',
    'VolumeDown',
    'Mute',
    'Unmute',
    'ToggleMute',
    'SetVolume',
    'SetAudioStreamIndex',
    'SetSubtitleStreamIndex',
    'ToggleFullscreen',
    'DisplayContent',
    'GoToSearch',
    'DisplayMessage',
    'SetRepeatMode',
    'ChannelUp',
    'ChannelDown',
    'Guide',
    'ToggleStats',
    'PlayMediaSource',
    'PlayTrailers',
    'SetShuffleQueue',
    'PlayState',
    'PlayNext',
    'ToggleOsdMenu',
    'Play',
    'SetMaxStreamingBitrate',
    'SetPlaybackOrder',
] as const;
export type GeneralCommandType = (typeof GENERAL_COMMAND_TYPES)[number];

/** MediaType values the SDK decodes (`PlayableMediaTypes`). */
export const MEDIA_TYPES = ['Unknown', 'Video', 'Audio', 'Photo', 'Book'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** BaseItemKind values `/Sessions/{id}/Viewing` accepts for `itemType`. */
export const BASE_ITEM_KINDS = [
    'AggregateFolder',
    'Audio',
    'AudioBook',
    'BasePluginFolder',
    'Book',
    'BoxSet',
    'Channel',
    'ChannelFolderItem',
    'CollectionFolder',
    'Episode',
    'Folder',
    'Genre',
    'ManualPlaylistsFolder',
    'Movie',
    'LiveTvChannel',
    'LiveTvProgram',
    'MusicAlbum',
    'MusicArtist',
    'MusicGenre',
    'MusicVideo',
    'Person',
    'Photo',
    'PhotoAlbum',
    'Playlist',
    'PlaylistsFolder',
    'Program',
    'Recording',
    'Season',
    'Series',
    'Studio',
    'Trailer',
    'TvChannel',
    'TvProgram',
    'UserRootFolder',
    'UserView',
    'Video',
    'Year',
] as const;

/**
 * ASP.NET Core binds enum route/query values case-insensitively, so
 * `/Playing/pause` and `playCommand=playnow` are valid Jellyfin requests.
 * Returns the canonical spelling, or null when the value is not a member.
 */
function matchEnum<T extends string>(
    values: readonly T[],
    raw: string | null | undefined,
): T | null {
    if (!raw) return null;
    const lower = raw.trim().toLowerCase();
    return values.find((v) => v.toLowerCase() === lower) ?? null;
}

export const parsePlayCommand = (raw: string | null | undefined): PlayCommand | null =>
    matchEnum(PLAY_COMMANDS, raw);
export const parsePlaystateCommand = (raw: string | null | undefined): PlaystateCommand | null =>
    matchEnum(PLAYSTATE_COMMANDS, raw);
export const parseGeneralCommandType = (
    raw: string | null | undefined,
): GeneralCommandType | null => matchEnum(GENERAL_COMMAND_TYPES, raw);
export const parseBaseItemKind = (raw: string | null | undefined): string | null =>
    matchEnum(BASE_ITEM_KINDS, raw);

/**
 * Keep only known values, canonically spelled, de-duplicated, in input order.
 * Accepts a comma-delimited string or repeated values (ASP.NET's
 * CommaDelimitedCollectionModelBinder takes both).
 */
function filterEnumList<T extends string>(values: readonly T[], raw: unknown): T[] {
    const parts: string[] = [];
    const push = (v: unknown): void => {
        if (typeof v !== 'string') return;
        for (const p of v.split(',')) if (p.trim()) parts.push(p);
    };
    if (Array.isArray(raw)) raw.forEach(push);
    else push(raw);
    const out: T[] = [];
    for (const p of parts) {
        const m = matchEnum(values, p);
        if (m && !out.includes(m)) out.push(m);
    }
    return out;
}

export const filterMediaTypes = (raw: unknown): MediaType[] => filterEnumList(MEDIA_TYPES, raw);
export const filterGeneralCommands = (raw: unknown): GeneralCommandType[] =>
    filterEnumList(GENERAL_COMMAND_TYPES, raw);

/** What a client reported via `POST /Sessions/Capabilities[/Full]`. */
export interface ReportedCapabilities {
    playableMediaTypes: MediaType[];
    supportedCommands: GeneralCommandType[];
    supportsMediaControl: boolean;
}

/** Parse a `ClientCapabilitiesDto` body (`/Sessions/Capabilities/Full`). */
export function capabilitiesFromDto(body: unknown): ReportedCapabilities {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    // The SDK sends PascalCase; tolerate camelCase from hand-rolled clients.
    const pick = (name: string): unknown => b[name] ?? b[name[0].toLowerCase() + name.slice(1)];
    return {
        playableMediaTypes: filterMediaTypes(pick('PlayableMediaTypes')),
        supportedCommands: filterGeneralCommands(pick('SupportedCommands')),
        supportsMediaControl: pick('SupportsMediaControl') === true,
    };
}

/** Parse ASP.NET-style booleans (`true`, `True`, `1`). */
export function parseBool(raw: string | null | undefined, fallback: boolean): boolean {
    if (raw === null || raw === undefined || raw === '') return fallback;
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return fallback;
}

const GUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Jellyfin's wire form of a Guid: 32 lowercase hex digits, no dashes. */
export function toWireGuid(id: string): string {
    return id.replace(/-/g, '').toLowerCase();
}

/** Dashed lowercase UUID, the form `media_items.id` stores. */
export function toDashedGuid(id: string): string {
    const h = toWireGuid(id);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Most item ids one remote-control request may carry (each costs an access check). */
export const MAX_COMMAND_ITEM_IDS = 500;
/** Most `Arguments` entries one GeneralCommand may carry. */
export const MAX_COMMAND_ARGUMENTS = 32;
/** Longest `Arguments` key or value, and the longest message Text/Header (UTF-8 bytes). */
export const MAX_COMMAND_STRING_BYTES = 4 * 1024;

const fitsStringCap = (v: string): boolean =>
    Buffer.byteLength(v, 'utf8') <= MAX_COMMAND_STRING_BYTES;

/** `Arguments` keys that carry item ids (Jellyfin's Arguments dictionary is case-insensitive). */
const isItemIdsArgument = (key: string): boolean => {
    const k = key.toLowerCase();
    return k === 'itemid' || k === 'itemids';
};

/**
 * An `ItemId`/`ItemIds` value is a comma-joined id list, bounded by count
 * (MAX_COMMAND_ITEM_IDS) rather than MAX_COMMAND_STRING_BYTES: a 500-id
 * queue is ~16 KB. The byte bound (64 per id, room for dashes and spaces)
 * only keeps padding out; the ids themselves are validated by parseItemIds.
 */
const fitsItemIdsCap = (v: string): boolean =>
    Buffer.byteLength(v, 'utf8') <= MAX_COMMAND_ITEM_IDS * 64 &&
    v.split(',').filter((p) => p.trim() !== '').length <= MAX_COMMAND_ITEM_IDS;

/**
 * Parse `itemIds` (comma-delimited and/or repeated). Returns null when any
 * entry is not a Guid — Jellyfin's model binder rejects the whole request —
 * or when there are more than MAX_COMMAND_ITEM_IDS of them.
 */
export function parseItemIds(raw: string[]): string[] | null {
    const ids: string[] = [];
    for (const value of raw) {
        for (const part of value.split(',')) {
            const p = part.trim();
            if (!p) continue;
            if (!GUID_RE.test(p)) return null;
            ids.push(toWireGuid(p));
            if (ids.length > MAX_COMMAND_ITEM_IDS) return null;
        }
    }
    return ids;
}

/** Parse an optional integer query value. `undefined` = absent, null = malformed. */
export function parseOptionalInt(raw: string | null): number | undefined | null {
    if (raw === null || raw.trim() === '') return undefined;
    if (!/^-?\d+$/.test(raw.trim())) return null;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Outbound WebSocket messages
// ---------------------------------------------------------------------------

export type OutboundMessageType =
    'ForceKeepAlive' | 'KeepAlive' | 'Play' | 'Playstate' | 'GeneralCommand' | 'Sessions';

export interface OutboundMessage<T = unknown> {
    MessageType: OutboundMessageType;
    /** Required by the SDK (non-nullable Guid). */
    MessageId: string;
    Data?: T;
}

export interface PlayRequestData {
    ItemIds: string[];
    StartPositionTicks?: number | null;
    PlayCommand: PlayCommand;
    ControllingUserId: string;
    SubtitleStreamIndex?: number | null;
    AudioStreamIndex?: number | null;
    MediaSourceId?: string | null;
    StartIndex?: number | null;
}

export interface PlaystateRequestData {
    Command: PlaystateCommand;
    SeekPositionTicks?: number | null;
    ControllingUserId?: string | null;
}

export interface GeneralCommandData {
    Name: GeneralCommandType;
    ControllingUserId: string;
    Arguments: Record<string, string>;
}

/** Wrap `data` the way Jellyfin's WebSocketConnection serializes it. */
export function outboundMessage<T>(type: OutboundMessageType, data?: T): OutboundMessage<T> {
    const message: OutboundMessage<T> = { MessageType: type, MessageId: toWireGuid(randomUUID()) };
    if (data !== undefined) message.Data = data;
    return message;
}

/**
 * Normalize a client-supplied `GeneralCommand` body (`POST /Command`). Returns
 * null when `Name` is missing or unknown, or when `Arguments` exceeds
 * MAX_COMMAND_ARGUMENTS entries or MAX_COMMAND_STRING_BYTES per key/value
 * (`ItemId`/`ItemIds` values: MAX_COMMAND_ITEM_IDS ids instead)
 * (the message is relayed through pub/sub to every replica).
 * `ControllingUserId` is always overwritten by the caller, as Jellyfin does.
 */
export function generalCommandFromBody(
    body: unknown,
    controllingUserId: string,
): GeneralCommandData | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    const name = parseGeneralCommandType(
        typeof (b.Name ?? b.name) === 'string' ? ((b.Name ?? b.name) as string) : null,
    );
    if (!name) return null;
    const rawArgs = (b.Arguments ?? b.arguments) as unknown;
    const args: Record<string, string> = {};
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
        const entries = Object.entries(rawArgs as Record<string, unknown>);
        if (entries.length > MAX_COMMAND_ARGUMENTS) return null;
        for (const [k, v] of entries) {
            // Dictionary<string, string>: drop nulls, stringify scalars.
            if (v === null || v === undefined) continue;
            let value: string;
            if (typeof v === 'string') value = v;
            else if (typeof v === 'number' || typeof v === 'boolean') value = String(v);
            else continue;
            const valueFits = isItemIdsArgument(k) ? fitsItemIdsCap(value) : fitsStringCap(value);
            if (!fitsStringCap(k) || !valueFits) return null;
            args[k] = value;
        }
    }
    return { Name: name, ControllingUserId: controllingUserId, Arguments: args };
}

/** GeneralCommands whose Arguments name items the target will open or play. */
export const ITEM_CARRYING_GENERAL_COMMANDS: ReadonlySet<GeneralCommandType> =
    new Set<GeneralCommandType>([
        'DisplayContent',
        'PlayMediaSource',
        'PlayTrailers',
        'Play',
        'PlayNext',
        'SetShuffleQueue',
    ]);

/**
 * The item ids an item-carrying GeneralCommand names in `Arguments.ItemId` /
 * `Arguments.ItemIds` (keys matched case-insensitively, as Jellyfin's
 * Arguments dictionary does). `[]` for any other command or when none are
 * given; null when an id is malformed or there are too many.
 */
export function generalCommandItemIds(command: GeneralCommandData): string[] | null {
    if (!ITEM_CARRYING_GENERAL_COMMANDS.has(command.Name)) return [];
    const raw: string[] = [];
    for (const [k, v] of Object.entries(command.Arguments)) {
        if (isItemIdsArgument(k)) raw.push(v);
    }
    return parseItemIds(raw);
}

/**
 * `MessageCommand` body → `DisplayMessage` GeneralCommand. Null when `Text` is
 * empty, or when `Text` or `Header` exceeds MAX_COMMAND_STRING_BYTES.
 */
export function messageCommandFromBody(
    body: unknown,
    controllingUserId: string,
): GeneralCommandData | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    const text = b.Text ?? b.text;
    if (typeof text !== 'string' || text.length === 0 || !fitsStringCap(text)) return null;
    const header = b.Header ?? b.header;
    if (typeof header === 'string' && !fitsStringCap(header)) return null;
    const timeout = b.TimeoutMs ?? b.timeoutMs;
    const args: Record<string, string> = {
        // SessionController substitutes this when the header is blank.
        Header: typeof header === 'string' && header.trim() ? header : 'Message from Server',
        Text: text,
    };
    if (typeof timeout === 'number' && Number.isFinite(timeout)) {
        args.TimeoutMs = String(Math.trunc(timeout));
    }
    return { Name: 'DisplayMessage', ControllingUserId: controllingUserId, Arguments: args };
}

/** Parse an inbound frame. Returns null for anything that is not a JSON message object. */
export function parseInboundMessage(raw: string): { type: string; data: unknown } | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    const type = p.MessageType ?? p.messageType;
    if (typeof type !== 'string') return null;
    return { type, data: p.Data ?? p.data };
}

/** Upper bound for the `SessionsStart` interval. */
export const SESSIONS_START_MAX_INTERVAL_MS = 60_000;

/**
 * `SessionsStart` data is `"<initialDelayMs>,<intervalMs>"`. Returns the
 * interval, clamped to [MIN, 60 s] so a client cannot make the server rebuild
 * the session list more than every MIN ms. The upper bound matters too: Node's
 * `setInterval` treats any delay above 2^31-1 ms as 1 ms.
 */
export function parseSessionsStartInterval(data: unknown, min: number, fallback: number): number {
    if (typeof data !== 'string') return fallback;
    const parts = data.split(',');
    const interval = Number(parts[1] ?? parts[0]);
    if (!Number.isFinite(interval) || interval <= 0) return fallback;
    return Math.min(SESSIONS_START_MAX_INTERVAL_MS, Math.max(min, Math.trunc(interval)));
}
