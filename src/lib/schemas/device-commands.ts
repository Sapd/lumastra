// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device remote control: the command vocabulary, the command object and the
 * device state, shared by the server defs, the OpenAPI docs and tests.
 *
 * Design: repo-root docs/superpowers/specs/2026-10-16-device-remote-control-design.md.
 *
 * Every command type is listed once in {@link DEVICE_COMMANDS}: its args schema
 * (strict, so a typo is a 422 and not a silent no-op) and how it is delivered.
 * Evolution is additive only — new optional args, new types — never a changed
 * meaning; no version numbers in type names.
 */

import { ImageSetSchema } from './api-image-descriptor.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Args per type
// ---------------------------------------------------------------------------

const NoArgs = z.object({}).strict();

export const MEDIA_PLAY_KINDS = [
    'movie',
    'episode',
    'series',
    'track',
    'album',
    'playlist',
    'artist',
    'audiobook',
] as const;
export type MediaPlayKind = (typeof MEDIA_PLAY_KINDS)[number];

const MediaPlayArgs = z
    .object({
        kind: z.enum(MEDIA_PLAY_KINDS).describe('What `itemId` is; `series` continues the series'),
        itemId: z.string().min(1).max(128).describe('Catalog id of the item'),
        mode: z
            .enum(['play', 'openDetail'])
            .default('play')
            .describe('Start playing, or only open the detail screen'),
        resume: z
            .boolean()
            .default(true)
            .describe('Continue from the saved position (false = from the beginning)'),
        startSeconds: z
            .number()
            .min(0)
            .max(86_400)
            .optional()
            .describe('Start here instead of the saved position'),
        context: z
            .object({
                kind: z.enum(['album', 'playlist', 'artist']),
                id: z.string().min(1).max(128),
            })
            .strict()
            .optional()
            .describe('Music: play the track inside this album / playlist / artist'),
        startIndex: z
            .number()
            .int()
            .min(0)
            .max(10_000)
            .optional()
            .describe('Music: start here in `context`'),
    })
    .strict();

const SleepTimerArgs = z
    .object({
        mode: z
            .enum(['off', 'minutes', 'endOfItem'])
            .describe('`endOfItem` = the end of the chapter, episode or track'),
        minutes: z.number().int().min(1).max(600).optional(),
    })
    .strict()
    .refine((a) => a.mode !== 'minutes' || a.minutes !== undefined, {
        message: '`minutes` is required when mode is "minutes"',
        path: ['minutes'],
    });

export const UI_MESSAGE_MAX_LENGTH = 280;
export const UI_MESSAGE_MAX_ACTIONS = 3;

/**
 * Control, zero-width, bidi and tag characters: no hidden or reordered text in a
 * message on someone's TV. Line feed (U+000A) stays allowed in the message text.
 */
const INVISIBLE_OR_BIDI =
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    /[\u0000-\u0009\u000B-\u001F\u007F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/;
/** Same, for one-line labels (no line breaks either). */
const INVISIBLE_OR_BIDI_OR_NEWLINE = new RegExp(`${INVISIBLE_OR_BIDI.source}|\\n`);

const UiMessageArgs = z
    .object({
        text: z
            .string()
            .trim()
            .min(1)
            .max(UI_MESSAGE_MAX_LENGTH)
            .refine((t) => !INVISIBLE_OR_BIDI.test(t), {
                message: 'Invisible or text-direction characters are not allowed',
            }),
        severity: z
            .enum(['info', 'warning', 'error'])
            .optional()
            .describe('How the device styles it (default info)'),
        actions: z
            .array(
                z
                    .object({
                        id: z.string().regex(/^[a-z0-9_-]{1,32}$/i),
                        label: z
                            .string()
                            .trim()
                            .min(1)
                            .max(40)
                            .refine((t) => !INVISIBLE_OR_BIDI_OR_NEWLINE.test(t), {
                                message:
                                    'Invisible, text-direction or line-break characters are not allowed',
                            }),
                    })
                    .strict(),
            )
            .max(UI_MESSAGE_MAX_ACTIONS)
            .optional()
            .describe('Buttons on the device; the one pressed comes back as `acknowledged`'),
    })
    .strict();

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export type DeviceCommandDelivery = 'queued' | 'live';

export interface DeviceCommandSpec {
    args: z.ZodType;
    /** `queued` may wait for the device; `live` is only meaningful now. */
    delivery: DeviceCommandDelivery;
    /** Lifetime from `notBefore` (or creation). */
    ttlSeconds: number;
    /** A new one replaces older pending ones of the same type for that device. */
    supersede?: boolean;
    /** May carry `notBefore` (then it waits like a queued command). */
    schedulable?: boolean;
    /** An admin may send it (admin route, audited). */
    admin?: boolean;
    summary: string;
}

export const DEVICE_COMMANDS = {
    'media.play': {
        args: MediaPlayArgs,
        delivery: 'queued',
        ttlSeconds: 300,
        supersede: true,
        summary:
            'Play (or open) a movie, episode, series, track, album, playlist, artist or audiobook',
    },
    'party.join': {
        args: z.object({ code: z.string().min(1).max(32) }).strict(),
        delivery: 'queued',
        ttlSeconds: 300,
        summary: 'Join a Watch Together party',
    },
    'livetv.tune': {
        args: z.object({ stationId: z.string().guid() }).strict(),
        delivery: 'queued',
        ttlSeconds: 300,
        supersede: true,
        summary: 'Switch to a Live TV channel',
    },
    'livetv.channelUp': { args: NoArgs, delivery: 'live', ttlSeconds: 15, summary: 'Next channel' },
    'livetv.channelDown': {
        args: NoArgs,
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Previous channel',
    },
    'playback.pause': { args: NoArgs, delivery: 'live', ttlSeconds: 15, summary: 'Pause' },
    'playback.resume': { args: NoArgs, delivery: 'live', ttlSeconds: 15, summary: 'Resume' },
    'playback.togglePause': {
        args: NoArgs,
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Pause or resume',
    },
    'playback.stop': {
        args: NoArgs,
        delivery: 'live',
        ttlSeconds: 15,
        schedulable: true,
        admin: true,
        summary: 'Stop playback (with `notBefore`: a sleep timer at a time)',
    },
    'playback.seekBy': {
        args: z.object({ seconds: z.number().min(-3600).max(3600) }).strict(),
        delivery: 'live',
        ttlSeconds: 10,
        summary: 'Jump forward (positive) or back (negative)',
    },
    'playback.seekTo': {
        args: z.object({ positionSeconds: z.number().min(0).max(86_400) }).strict(),
        delivery: 'live',
        ttlSeconds: 10,
        summary: 'Jump to a position',
    },
    'playback.next': {
        args: NoArgs,
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Next episode, track or chapter',
    },
    'playback.previous': {
        args: NoArgs,
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Previous episode, track or chapter',
    },
    'playback.setRate': {
        args: z.object({ rate: z.number().min(0.5).max(3) }).strict(),
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Playback speed',
    },
    'playback.setSleepTimer': {
        args: SleepTimerArgs,
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Stop after N minutes or at the end of the chapter / episode / track',
    },
    'playback.setAudioTrack': {
        args: z.object({ index: z.number().int().min(0).max(255) }).strict(),
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Choose an audio track (index from the state)',
    },
    'playback.setSubtitleTrack': {
        args: z
            .object({
                index: z.number().int().min(-1).max(255).describe('-1 switches subtitles off'),
            })
            .strict(),
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Choose a subtitle track; index -1 switches subtitles off',
    },
    'playback.skipSegment': {
        args: z.object({ kind: z.enum(['intro', 'recap', 'credits', 'preview']) }).strict(),
        delivery: 'live',
        ttlSeconds: 10,
        summary: 'Skip the intro / recap / credits / preview that is playing',
    },
    'playback.cancelAutoplay': {
        args: NoArgs,
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Do not start the next episode',
    },
    'playback.setShuffle': {
        args: z.object({ on: z.boolean() }).strict(),
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Music: shuffle on or off',
    },
    'playback.setRepeat': {
        args: z.object({ mode: z.enum(['off', 'one', 'all']) }).strict(),
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Music: repeat mode',
    },
    'queue.add': {
        args: z
            .object({
                itemIds: z.array(z.string().min(1).max(128)).min(1).max(500),
                position: z.enum(['next', 'end']).default('end'),
            })
            .strict(),
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Music: add tracks to the queue',
    },
    'queue.remove': {
        args: z.object({ index: z.number().int().min(0).max(10_000) }).strict(),
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Music: remove one queue entry (needs expect.queueRevision)',
    },
    'queue.move': {
        args: z
            .object({
                from: z.number().int().min(0).max(10_000),
                to: z.number().int().min(0).max(10_000),
            })
            .strict(),
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Music: move a queue entry (needs expect.queueRevision)',
    },
    'queue.jumpTo': {
        args: z.object({ index: z.number().int().min(0).max(10_000) }).strict(),
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Music: play this queue entry now (needs expect.queueRevision)',
    },
    'queue.clear': {
        args: NoArgs,
        delivery: 'live',
        ttlSeconds: 15,
        summary: 'Music: clear what comes after the playing track',
    },
    'ui.message': {
        args: UiMessageArgs,
        delivery: 'live',
        ttlSeconds: 120,
        schedulable: true,
        admin: true,
        summary: 'Show a short message, optionally with buttons',
    },
} as const satisfies Record<string, DeviceCommandSpec>;

export type DeviceCommandType = keyof typeof DEVICE_COMMANDS;
export const DEVICE_COMMAND_TYPES = Object.keys(DEVICE_COMMANDS) as DeviceCommandType[];

/** Queue edits name the queue they were made against. */
export const QUEUE_REVISION_REQUIRED: ReadonlySet<DeviceCommandType> = new Set([
    'queue.remove',
    'queue.move',
    'queue.jumpTo',
]);

/** Admin messages live shorter: a "restarting in 5 minutes" must never come late. */
export const ADMIN_UI_MESSAGE_TTL_SECONDS = 30;

export function isDeviceCommandType(value: unknown): value is DeviceCommandType {
    return (
        typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEVICE_COMMANDS, value)
    );
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const DeviceCommandExpectSchema = z
    .object({
        sessionId: z
            .string()
            .min(1)
            .max(128)
            .optional()
            .describe('Only if this is still playing (play session id, or livetv:<stationId>)'),
        queueRevision: z.number().int().nonnegative().optional().describe('Music queue revision'),
    })
    .strict()
    .describe('Preconditions; a mismatch is 409 stale_target');

/**
 * `POST /devices/{id}/commands` body. One object per type so the OpenAPI doc
 * (and generated clients) see a discriminated union on `type`.
 */
function requestVariant<T extends DeviceCommandType>(type: T) {
    const spec: DeviceCommandSpec = DEVICE_COMMANDS[type];
    const base = {
        type: z.literal(type),
        args: spec.args === NoArgs ? NoArgs.optional() : spec.args,
        expect: DeviceCommandExpectSchema.optional(),
    };
    return spec.schedulable || spec.delivery === 'queued'
        ? z
              .object({
                  ...base,
                  notBefore: z
                      .string()
                      .datetime({ offset: true })
                      .optional()
                      .describe('Do it at this time (the device waits; cancel with DELETE)'),
              })
              .strict()
        : z.object(base).strict();
}

export const DeviceCommandRequestSchema = z
    .discriminatedUnion(
        'type',
        DEVICE_COMMAND_TYPES.map((t) => requestVariant(t)) as unknown as [
            ReturnType<typeof requestVariant>,
            ...ReturnType<typeof requestVariant>[],
        ],
    )
    .meta({ id: 'DeviceCommandRequest', description: 'A command for a device' });

export type DeviceCommandRequest = {
    type: DeviceCommandType;
    args?: Record<string, unknown>;
    expect?: z.infer<typeof DeviceCommandExpectSchema>;
    notBefore?: string;
};

// ---------------------------------------------------------------------------
// Command object
// ---------------------------------------------------------------------------

export const DEVICE_COMMAND_STATUSES = [
    'pending',
    'delivered',
    'applied',
    'rejected',
    'expired',
    'superseded',
    'cancelled',
    'acknowledged',
] as const;
export type DeviceCommandStatus = (typeof DEVICE_COMMAND_STATUSES)[number];

/** Statuses after which nothing more happens to a command. */
export const FINAL_COMMAND_STATUSES: ReadonlySet<DeviceCommandStatus> = new Set([
    'rejected',
    'expired',
    'superseded',
    'cancelled',
    'acknowledged',
]);

export const DEVICE_COMMAND_SOURCES = ['app', 'automation', 'admin'] as const;
export type DeviceCommandSource = (typeof DEVICE_COMMAND_SOURCES)[number];

export const DeviceCommandSchema = z
    .object({
        id: z.string(),
        deviceSessionId: z.string().describe('Target device'),
        type: z.enum(DEVICE_COMMAND_TYPES as [DeviceCommandType, ...DeviceCommandType[]]),
        args: z.record(z.string(), z.unknown()),
        expect: DeviceCommandExpectSchema.optional(),
        notBefore: z.string().optional(),
        delivery: z.enum(['queued', 'live']),
        source: z.enum(DEVICE_COMMAND_SOURCES).describe('Set by the server from the credential'),
        sender: z
            .object({
                username: z.string(),
                deviceSessionId: z.string().optional(),
                deviceName: z.string().optional(),
                admin: z.boolean().optional(),
            })
            .describe('Who sent it; the device shows this next to a message'),
        status: z.enum(DEVICE_COMMAND_STATUSES),
        reason: z.string().optional().describe('Why it was rejected'),
        actionId: z.string().optional().describe('ui.message: the button that was pressed'),
        createdAt: z.string(),
        updatedAt: z.string(),
        expiresAt: z.string(),
    })
    .meta({ id: 'DeviceCommand', description: 'A command sent to a device, with its status' });

export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;

export const DeviceCommandResultSchema = z
    .object({
        status: z.enum(['delivered', 'applied', 'rejected', 'acknowledged']),
        reason: z
            .string()
            .max(64)
            .regex(/^[a-z0-9_]+$/)
            .optional()
            .describe('With rejected: stale_target, no_segment, unsupported, account_mismatch, …'),
        actionId: z.string().max(32).optional().describe('With acknowledged: the button pressed'),
    })
    .strict()
    .meta({ id: 'DeviceCommandResult', description: 'What the device did with a command' });

// ---------------------------------------------------------------------------
// Device state
// ---------------------------------------------------------------------------

const TrackSchema = z.object({
    index: z.number().int(),
    label: z.string().max(200),
    language: z.string().max(16).optional(),
});

const NowPlayingReportSchema = z
    .object({
        kind: z.enum(['video', 'livetv', 'music', 'audiobook']),
        sessionId: z.string().max(128).describe('Play session id, or livetv:<stationId>'),
        title: z.string().max(500),
        subtitle: z.string().max(500).optional(),
        artworkUrl: z.string().max(2000).optional(),
        positionSeconds: z.number().min(0).optional(),
        durationSeconds: z.number().min(0).optional(),
        paused: z.boolean(),
        rate: z.number().min(0).max(4).default(1),
        observedAt: z.string().optional().describe('Set by the server when the report arrives'),
        reported: z
            .boolean()
            .optional()
            .describe('false: derived by the server, the device does not report state'),
        availableCommands: z
            .array(z.string().max(64))
            .max(64)
            .default([])
            .describe('What works right now; a remote shows only these'),
        video: z
            .object({
                itemId: z.string().max(128),
                mediaType: z.string().max(32).optional(),
                seriesId: z.string().max(128).optional(),
                seasonNumber: z.number().int().optional(),
                episodeNumber: z.number().int().optional(),
                audioTracks: z.array(TrackSchema).max(64).default([]),
                audioIndex: z.number().int().nullable().optional(),
                subtitleTracks: z.array(TrackSchema).max(128).default([]),
                subtitleIndex: z.number().int().nullable().optional(),
                segments: z
                    .array(
                        z.object({ kind: z.string().max(32), start: z.number(), end: z.number() }),
                    )
                    .max(64)
                    .default([]),
                nextEpisode: z
                    .object({
                        itemId: z.string().max(128),
                        title: z.string().max(500),
                        countdownSeconds: z.number().optional(),
                    })
                    .optional(),
            })
            .passthrough()
            .optional(),
        livetv: z
            .object({
                stationId: z.string().max(128),
                feedId: z.string().max(128),
                number: z.number().int().optional(),
                name: z.string().max(200),
                images: ImageSetSchema.optional(),
                programme: z.string().max(500).optional(),
                nextProgramme: z.string().max(500).optional(),
            })
            .passthrough()
            .optional(),
        music: z
            .object({
                trackId: z.string().max(128),
                artist: z.string().max(500).optional(),
                album: z.string().max(500).optional(),
                queue: z
                    .object({
                        items: z
                            .array(
                                z.object({
                                    id: z.string().max(128),
                                    title: z.string().max(500),
                                    artist: z.string().max(500).optional(),
                                }),
                            )
                            .max(500),
                        index: z.number().int().min(0),
                        revision: z.number().int().nonnegative(),
                    })
                    .optional(),
                shuffle: z.boolean().optional(),
                repeat: z.enum(['off', 'one', 'all']).optional(),
            })
            .passthrough()
            .optional(),
        audiobook: z
            .object({
                bookId: z.string().max(128),
                author: z.string().max(500).optional(),
                chapters: z
                    .array(
                        z.object({
                            index: z.number().int(),
                            title: z.string().max(500),
                            start: z.number(),
                        }),
                    )
                    .max(1000)
                    .default([]),
                chapterIndex: z.number().int().nullable().optional(),
            })
            .passthrough()
            .optional(),
        sleepTimer: z
            .object({
                mode: z.enum(['minutes', 'endOfItem']),
                endsAt: z.string().optional(),
            })
            .nullable()
            .optional(),
    });

/** What the device plays now as served: the report shape with the duration in milliseconds. */
const NowPlayingSchema = NowPlayingReportSchema.omit({ durationSeconds: true })
    .extend({ durationMs: z.number().int().min(0).optional() })
    .meta({ id: 'DeviceNowPlaying', description: 'What the device plays now' });

export type DeviceNowPlaying = z.infer<typeof NowPlayingSchema>;

/** What a device reports (`PUT /devices/{id}/state`). */
export const DeviceStateReportSchema = z
    .object({
        nowPlaying: NowPlayingReportSchema.nullable(),
        liveTvMode: z.enum(['simple', 'standard']).optional(),
        textInput: z
            .object({
                active: z.boolean(),
                fieldId: z.string().max(64).optional(),
                placeholder: z.string().max(200).optional(),
            })
            .nullable()
            .optional()
            .describe('Reserved: the device has a text field the phone could type into'),
        party: z
            .object({ code: z.string().max(32), role: z.enum(['host', 'guest']) })
            .nullable()
            .optional()
            .describe('Reserved: the device is in a Watch Together party'),
    })
    .meta({ id: 'DeviceStateReport', description: 'A device reporting its own state' });

export type DeviceStateReport = z.infer<typeof DeviceStateReportSchema>;

/** Per-type capability options a device announces; unknown keys are kept. */
export const DeviceCapabilitiesSchema = z
    .object({
        commands: z
            .record(z.string().max(64), z.object({}).passthrough())
            .describe('Command types the device carries out, with per-type options'),
        liveTvMode: z.enum(['simple', 'standard']).optional(),
    })
    .meta({ id: 'DeviceCapabilities', description: 'What a device can do' });

export type DeviceCapabilities = z.infer<typeof DeviceCapabilitiesSchema>;

export const DeviceStateSchema = z
    .object({
        deviceSessionId: z.string(),
        deviceName: z.string().nullable(),
        deviceType: z.string(),
        online: z.boolean(),
        lastSeen: z.string().nullable(),
        reachable: z.boolean().describe('The device has an open event stream (live commands work)'),
        capabilities: DeviceCapabilitiesSchema,
        nowPlaying: NowPlayingSchema.nullable(),
        liveTvMode: z.enum(['simple', 'standard']).optional(),
        textInput: DeviceStateReportSchema.shape.textInput,
        party: DeviceStateReportSchema.shape.party,
        revision: z.number().int().describe('Increases with every change; ignore older ones'),
    })
    .meta({ id: 'DeviceState', description: 'A device and what it plays now' });

export type DeviceState = z.infer<typeof DeviceStateSchema>;
