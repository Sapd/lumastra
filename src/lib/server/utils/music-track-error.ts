// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Postgres error codes meaning "this write named a track that cannot be
 * written", as opposed to a transient failure. `23503` is a foreign-key
 * violation (music_listen_events.track_id, user_music_state.track_id, and
 * user_ratings.media_id all reference media_items.id); `22P02` is an invalid
 * UUID reaching a cast — reachable via a non-UUID `{id}` path param on routes
 * whose params schema only requires a non-empty string.
 *
 * `checkMediaAccess` short-circuits to "allowed" for an unrestricted,
 * non-age-restricted caller without ever looking the id up (see
 * `isMediaAccessible` / `getDeniedLibraryGroups`), so a trackId that does not
 * exist only surfaces here, at the write. Both codes are permanently doomed,
 * never "retry me" — callers translate this into a 404 rather than a 500
 * that invites an endless retry.
 *
 * Shared by the music play-end batch (`music/progress/end{,/batch}`) and
 * `MusicInteractionManager`'s track-feedback writes (like/dislike/skip/
 * complete) — both hit the same shape through the same access-gate hole.
 */
export function isMissingTrackError(err: unknown): boolean {
    const code = (err as { code?: string } | null)?.code;
    return code === '23503' || code === '22P02';
}
