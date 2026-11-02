// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * episode-availability.ts — single source of truth for the "why can't I play
 * this episode?" badge shown in the series modal.
 *
 * The classification is deliberately THREE-valued on the air-date axis, not two.
 * A missing `premiereDate` is not evidence that the episode aired — TMDB stubs
 * for an announced-but-undated season carry no date at all, and the arr calendar
 * only backfills `media_items.premiere_date` for episodes inside its lookahead
 * window (see `tasks/builtin/native/release-calendar-sync.ts`). Collapsing
 * "unknown" into "aired" made every episode of an unannounced future season
 * render the red `Not on disk` badge, whose tooltip flatly claims the episode
 * has already aired.
 */

/**
 * Why an episode row is not playable.
 *
 * - `available`  — a file is present (or presence is unknown, which callers
 *                  have always treated as present); no badge.
 * - `unreleased` — premiere date is strictly after the start of today.
 * - `missing`    — premiere date is known and has passed, but no file.
 * - `undated`    — no usable premiere date AND no file. We do not know whether
 *                  it aired, so nothing about airing may be asserted.
 */
export type EpisodeAvailability = 'available' | 'unreleased' | 'missing' | 'undated';

export interface EpisodeAvailabilityInput {
    /** ISO date/datetime string. Missing or unparseable ⇒ unknown air date. */
    premiereDate?: string | null;
    /** `true` and `undefined` both mean "file present" — only `false` is absence. */
    hasFile?: boolean;
}

/** Calendar day as a comparable `YYYYMMDD` integer. */
const dayNumber = (y: number, mZeroBased: number, d: number): number =>
    y * 10000 + (mZeroBased + 1) * 100 + d;

/**
 * The episode's air day, read in UTC.
 *
 * `premiere_date` is a Postgres `date` column, so the API always serialises it
 * as UTC midnight (`2026-08-28T00:00:00.000Z`). Comparing that instant against
 * a *local* midnight makes an episode airing today read as "future" for every
 * user east of UTC — the boundary must be compared day-to-day, not instant-to-
 * instant, or the "strictly after the start of today" rule silently shifts.
 */
const airDayNumber = (airDate: Date): number =>
    dayNumber(airDate.getUTCFullYear(), airDate.getUTCMonth(), airDate.getUTCDate());

/** Today, in the viewer's own timezone — "has it aired for *me* yet". */
const todayNumber = (now: Date): number =>
    dayNumber(now.getFullYear(), now.getMonth(), now.getDate());

/**
 * Classify an episode row for badge rendering.
 *
 * @param episode - premiere date + file presence as returned by
 *   `/api/series/{id}/episodes`.
 * @param now - injectable clock; defaults to the current time. Tests pass a
 *   fixed instant so the today-boundary cases are deterministic.
 */
export function classifyEpisodeAvailability(
    episode: EpisodeAvailabilityInput,
    now: Date = new Date(),
): EpisodeAvailability {
    const parsed = episode.premiereDate ? new Date(episode.premiereDate) : null;
    const airDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

    // A future air date wins over file presence: a pre-seeded file for an
    // unaired episode is still not something we claim is on disk today.
    if (airDate && airDayNumber(airDate) > todayNumber(now)) return 'unreleased';

    if (episode.hasFile !== false) return 'available';

    return airDate ? 'missing' : 'undated';
}

/**
 * Whether a row should survive the admin visibility toggles.
 *
 * `undated` rows ride with `showMissing`: they are, factually, not on disk, and
 * grouping them there preserves the pre-existing hide/show behaviour for the
 * large population of dateless specials.
 */
export function isEpisodeVisible(
    availability: EpisodeAvailability,
    toggles: { showUnaired: boolean; showMissing: boolean },
): boolean {
    if (availability === 'unreleased') return toggles.showUnaired;
    if (availability === 'missing' || availability === 'undated') return toggles.showMissing;
    return true;
}
