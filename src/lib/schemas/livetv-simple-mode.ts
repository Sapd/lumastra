// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV simple mode: a senior-friendly Live TV screen that a helper (the
 * user, someone on their account, or the admin) sets up. The channels are the
 * user's favorites, in favorite order; the channel number is the position.
 */

import { z } from 'zod';
import { publicAuthorSchema } from './public-author.js';

export const SIMPLE_MODE_LAYOUTS = ['tv', 'list', 'tiles'] as const;
export type SimpleModeLayout = (typeof SIMPLE_MODE_LAYOUTS)[number];

export const SIMPLE_MODE_TEXT_SIZES = ['large', 'xlarge'] as const;
export type SimpleModeTextSize = (typeof SIMPLE_MODE_TEXT_SIZES)[number];

/** A simple-mode channel list longer than this is not simple any more. */
export const SIMPLE_MODE_MAX_CHANNELS = 99;

/** PIN: 4 to 8 digits. */
export const SimpleModePinSchema = z
    .string()
    .regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits')
    .describe('Lock PIN, 4 to 8 digits');

export const LiveTvSimpleModeSchema = z
    .object({
        enabled: z.boolean().describe('Simple mode is on for this user'),
        layout: z
            .enum(SIMPLE_MODE_LAYOUTS)
            .describe(
                'tv = opens on the picture, Up/Down changes channel; list = numbered list with now/next; tiles = large tiles',
            ),
        textSize: z.enum(SIMPLE_MODE_TEXT_SIZES).describe('large or xlarge (1.25x)'),
        startStationId: z
            .string()
            .guid()
            .optional()
            .describe('Channel the TV layout opens with; absent = the first channel'),
        autostart: z
            .boolean()
            .describe('Open Live TV when the app starts (web: the home page goes to Live TV)'),
        locked: z
            .boolean()
            .describe(
                "Locked: changing or leaving simple mode on the user's own account needs the PIN",
            ),
        updatedAt: z.string().optional().describe('ISO time of the last change'),
        updatedBy: publicAuthorSchema
            .optional()
            .describe('Who made the last change (the user, a helper or an admin)'),
        stationIds: z
            .array(z.string().guid())
            .describe(
                "The simple-mode channels in order (the user's favorites); channel number = position + 1",
            ),
    })
    .meta({
        id: 'LiveTvSimpleMode',
        description: 'Senior-friendly Live TV simple mode of one user',
    });

export type LiveTvSimpleMode = z.infer<typeof LiveTvSimpleModeSchema>;

export const LiveTvSimpleModeUpdateSchema = z
    .object({
        enabled: z.boolean().optional(),
        layout: z.enum(SIMPLE_MODE_LAYOUTS).optional(),
        textSize: z.enum(SIMPLE_MODE_TEXT_SIZES).optional(),
        startStationId: z
            .string()
            .guid()
            .optional()
            .describe('Start channel; must be one of the channels'),
        clearStartStation: z
            .boolean()
            .optional()
            .describe('true = open with the first channel (clears startStationId)'),
        autostart: z.boolean().optional(),
        locked: z
            .boolean()
            .optional()
            .describe('true needs newPin (or a PIN already set); false removes the lock and PIN'),
        newPin: SimpleModePinSchema.optional().describe('Set or change the lock PIN'),
        pin: SimpleModePinSchema.optional().describe(
            'Current PIN; required to change a locked setup on your own account',
        ),
        stationIds: z
            .array(z.string().guid())
            .max(SIMPLE_MODE_MAX_CHANNELS)
            .optional()
            .describe('Replaces the favorites with exactly these channels, in this order'),
    })
    .meta({
        id: 'LiveTvSimpleModeUpdate',
        description: 'Partial update of Live TV simple mode; omitted fields stay',
    });

export type LiveTvSimpleModeUpdate = z.infer<typeof LiveTvSimpleModeUpdateSchema>;

export const LiveTvSimpleModePinCheckSchema = z
    .object({ pin: SimpleModePinSchema })
    .meta({ id: 'LiveTvSimpleModePinCheck', description: 'Check the simple-mode lock PIN' });

export type LiveTvSimpleModePinCheck = z.infer<typeof LiveTvSimpleModePinCheckSchema>;
