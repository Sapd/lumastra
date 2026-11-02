// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The TEXT half of a notification's rendering: kind + payload → {title, body}.
 *
 * Split out of `push-rich-content.ts` so it can be imported WITHOUT the artwork
 * half. That half reaches into `catalog-operations.queries` and
 * `media-artwork.queries` and needs a `postgres.Sql`; this half is pure and
 * synchronous. The inbox presenter (`notification-display.service.ts`) renders
 * every listed row's title/body and must not drag a recursive-CTE artwork
 * probe into a list endpoint to do it.
 *
 * There is exactly ONE per-kind text renderer in this codebase and this is it —
 * the push banner, the NSE content endpoint and the inbox `display` block all
 * come through `composePushContent`. That is the point: a notification that
 * reads one way on the lock screen and another way in the drawer is the drift
 * this consolidation exists to prevent.
 *
 * `push-rich-content.ts` re-exports the public surface here, so every existing
 * import keeps working unchanged.
 *
 * @module services/push/push-content-text
 */

import { m } from '$lib/paraglide/messages.js';
import {
    KIND_ADMIN_BROADCAST,
    KIND_JELLYFIN_READONLY_TOKEN,
    KIND_LIBRARY_NEW_EPISODE,
    KIND_REQUEST_AVAILABLE,
} from '$lib/shared/user-event-kinds.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import { isReleaseStyleTitle } from '$lib/server/utils/episode-release-title.js';
import { contentFreeAlert, type PushLocale } from './push-payload.js';

export interface PushRichContent {
    title: string;
    body: string;
}

export function nonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function positiveInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    return value;
}

/** `S02E07` — the form every client and every fansub has agreed on. */
function episodeCode(season: number, episode: number): string {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `S${pad(season)}E${pad(episode)}`;
}

function newEpisodeContent(
    payload: Record<string, unknown>,
    locale: PushLocale,
): PushRichContent | null {
    const seriesTitle = nonEmptyString(payload.seriesTitle);
    if (!seriesTitle) return null;

    const season = positiveInteger(payload.seasonNumber);
    const episode = positiveInteger(payload.episodeNumber);
    // A release file name stored as the title (unmatched or Jellyfin-named
    // episodes) reads as noise in a banner — fall back to the untitled body.
    const rawEpisodeTitle = nonEmptyString(payload.episodeTitle);
    const episodeTitle =
        rawEpisodeTitle && !isReleaseStyleTitle(rawEpisodeTitle) ? rawEpisodeTitle : null;

    if (season === null || episode === null) {
        // Numbering is missing (a special, or an incompletely matched item).
        // The series name alone is still a real improvement over the generic
        // banner, so keep it and fall back to the generic body.
        return { title: seriesTitle, body: m.push_new_episode_body({}, { locale }) };
    }

    const code = episodeCode(season, episode);
    return {
        title: seriesTitle,
        body: episodeTitle
            ? m.push_rich_new_episode_body_titled({ code, title: episodeTitle }, { locale })
            : m.push_rich_new_episode_body({ code }, { locale }),
    };
}

function requestAvailableContent(
    payload: Record<string, unknown>,
    locale: PushLocale,
): PushRichContent | null {
    const title = nonEmptyString(payload.title);
    if (!title) return null;

    const year = positiveInteger(payload.year);
    return {
        title: year === null ? title : `${title} (${year})`,
        body: m.push_request_available_body({}, { locale }),
    };
}

/**
 * An admin announcement's text is the admin's own words, verbatim.
 *
 * The one kind here that does NOT compose its text from a Paraglide message.
 * The other two describe a server-side event, so the server owns the wording
 * and localizes it; this one carries a human's message, and translating —
 * or paraphrasing — what an operator wrote would be a lie about what they said.
 * The `locale` parameter is therefore deliberately unused on this branch.
 *
 * Returns null on a title-less payload rather than substituting a placeholder,
 * so the caller falls through to `contentFreeAlert`. That fallback is what
 * preserves the invariant `display.title` depends on (never empty) for a row
 * whose payload was written by some other server version, or truncated.
 *
 * `body` is optional on a broadcast, and an absent one becomes `''` rather than
 * a fabricated second line — `PushRichContent.body` is non-optional, and a
 * title-only announcement is a legitimate thing to send.
 */
function adminBroadcastContent(payload: Record<string, unknown>): PushRichContent | null {
    const title = nonEmptyString(payload.title);
    if (!title) return null;
    return { title, body: nonEmptyString(payload.body) ?? '' };
}

/**
 * The text the extension substitutes into the banner, and the same text the
 * inbox row renders.
 *
 * Falls back to the CONTENT-FREE alert whenever the stored payload cannot
 * produce something better. That is the same text iOS would display if the
 * extension timed out, so the worst case of a thin payload is "no change",
 * never a blank or half-built banner — and, for the inbox, it is what makes
 * `display.title` safe to declare non-optional: this function cannot return an
 * empty title for any kind, known or not.
 */
export function composePushContent(
    kind: string,
    payload: unknown,
    locale: PushLocale,
): PushRichContent {
    if (kind === KIND_JELLYFIN_READONLY_TOKEN) {
        return {
            title: m.jellyfin_readonly_token_notice_title({}, { locale }),
            body: m.jellyfin_readonly_token_notice_body({}, { locale }),
        };
    }

    const data = isRecord(payload) ? payload : {};

    const rich =
        kind === KIND_LIBRARY_NEW_EPISODE
            ? newEpisodeContent(data, locale)
            : kind === KIND_REQUEST_AVAILABLE
              ? requestAvailableContent(data, locale)
              : kind === KIND_ADMIN_BROADCAST
                ? adminBroadcastContent(data)
                : null;

    return rich ?? contentFreeAlert(kind, locale);
}
