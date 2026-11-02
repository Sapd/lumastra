// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/**
 * AutoplaySeed: optional context that biases smart queue results.
 * When present, the queue blends seed-context embeddings into similarity
 * scoring for cross-artist discovery.
 */
export const AutoplaySeedSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('mood'),
        mood: z.string(),
        label: z.string(),
        emoji: z.string(),
    }),
    z.object({
        type: z.literal('genre'),
        genre: z.string(),
        label: z.string(),
    }),
    z.object({
        type: z.literal('artist'),
        artistId: z.string(),
        artistName: z.string(),
    }),
    z.object({
        type: z.literal('album'),
        albumId: z.string(),
        albumName: z.string(),
        artistName: z.string().optional(),
    }),
]);

export type AutoplaySeed = z.infer<typeof AutoplaySeedSchema>;

/**
 * PlaybackContext: display-only label for the queue panel.
 * NOT a seed — does not affect smart queue results.
 * Shows what the user explicitly chose to play.
 * Auto-transitions to null when queued tracks run out.
 */
export const PlaybackContextSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('mix'),
        name: z.string(),
        trackCount: z.number(),
        href: z.string(),
    }),
    z.object({
        type: z.literal('artist'),
        name: z.string(),
        trackCount: z.number(),
    }),
    z.object({
        type: z.literal('album'),
        name: z.string(),
        trackCount: z.number(),
        sessionId: z.string(),
    }),
    z.object({
        type: z.literal('genre'),
        name: z.string(),
    }),
    z.object({
        type: z.literal('station'),
        /** Auto-resolved label (e.g. "DJ Manian + R.I.O."), not user-editable. */
        name: z.string(),
        /** Version-bound taste-station id this queue came from. */
        stationId: z.string(),
        href: z.string().optional(),
    }),
]);

export type PlaybackContext = z.infer<typeof PlaybackContextSchema>;
