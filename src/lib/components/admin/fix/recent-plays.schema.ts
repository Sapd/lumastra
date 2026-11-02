// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for "what was played recently, and by whom".
 *
 * Feeds the picker on /admin/fix/why-transcode. That page asks for a media id
 * and had no way to obtain one: the operator pasted a UUID by hand, and a
 * mistyped or spliced id came back as a bare 422 with nothing to act on.
 *
 * Sourced from `play_sessions` — the SAME table the decision itself is read
 * from — so every row offered here is guaranteed to have a decision to show.
 * A picker built from `media_items` would happily offer titles that have never
 * been played and answer "no sessions recorded" for most of them.
 */

import { z } from 'zod';

export const RecentPlaySchema = z.object({
    mediaId: z.string(),
    mediaTitle: z.string(),
    /** Null when the session's user row is gone (deleted account). */
    username: z.string().nullable(),
    startedAt: z.string(),
    /** direct / remux / audio_transcode / full_transcode / audio_only. */
    playMethod: z.string(),
    clientName: z.string().nullable(),
});
export type RecentPlay = z.infer<typeof RecentPlaySchema>;

export const RecentPlaysSchema = z.object({
    generatedAt: z.string(),
    plays: z.array(RecentPlaySchema),
});
export type RecentPlays = z.infer<typeof RecentPlaysSchema>;
