// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { MUSIC_HYGIENE_VIEW, type MusicHygieneFinding } from './music-hygiene.js';

/**
 * Canonical deep links into the admin media browser.
 *
 * These live in ONE place because the media browser resolves an absent `type`
 * param to a domain default, so a link that omits it silently filters the list
 * it was built to open. Seven call sites — two attention adapters (each with a
 * `sourceRef` and an action `href`), the legacy-path map, the file-issues panel
 * and the System → Health findings list — used to spell the same URL by hand,
 * and every one of them carried the same defect.
 */

/**
 * "Items with file health or integrity issues."
 *
 * The type scope is NOT optional decoration. Without it the browser falls back
 * to `defaultTypeForDomain('video')` = `'main'` = `['movie','tv']`
 * (`media-filters.ts`), so every affected episode, track and audiobook is
 * unreachable from the link and the attention count — which counts files across
 * all types — can never match the list it opens. Measured on a production
 * catalogue when this was fixed: the unscoped link listed 28 of 121 affected
 * items, hiding all 93 affected episodes.
 *
 * `domain` and `type` must stay a matching pair: `inferDomain('all')` is
 * `'everything'` and `defaultTypeForDomain('everything')` is `'all'`. A pair
 * that disagrees renders the wrong filter chips and the wrong stats tiles.
 * `admin-media-links.test.ts` asserts both directions.
 *
 * Availability and dismissal are deliberately left at their defaults: an item
 * with a file issue has files by definition, and both toggles were verified to
 * exclude nothing from this filter.
 */
export const ADMIN_MEDIA_FILE_ISSUES_PATH =
    '/admin/library/media?filter=file-issues&domain=everything&type=all';

/**
 * "Files with recorded health issues" — the System → Health page's file section.
 *
 * Deliberately NOT the media browser, and that is the whole point of it having
 * its own constant. `countFilesWithHealthIssues` — the number the attention
 * badge renders — is a COUNT over `media_files`; the media browser lists
 * `media_items`. Three populations diverge, and only one of them is about media
 * types, so no value of `?type=` reconciles the badge with the list:
 *
 * - An `extra` (a trailer, a featurette) is a real file that can carry a real
 *   `truncated_video`, but `ALL_BROWSABLE_TYPES` (`media-filters.ts`) excludes
 *   `extra`, so `?type=all` — the widest scope the browser offers — cannot list
 *   it. Observed on preprod: badge 2, list 0, both items `media_type = 'extra'`.
 * - A file linked to NO media item is counted and is structurally unlistable by
 *   a browser over `media_items`, under any filter. `listScanIssues`
 *   (`media-files.queries.ts`) surfaces some of these on the Ingest Map, but
 *   only for `tag_parse_timeout` / `tag_parse_corrupt` / `filename_not_utf8` —
 *   an item-less `truncated_video` appears on no surface at all.
 * - A multi-episode file is ONE file and N items, so the browser can
 *   OVER-count the badge exactly as easily as it under-counts it.
 *
 * `GET /api/admin/media/file-health` returns the same `media_files` rows the
 * count is taken from, with a nullable `media_item_id`, so the panel behind this
 * anchor agrees with the badge by construction rather than by chasing types.
 *
 * `ADMIN_MEDIA_FILE_ISSUES_PATH` above stays where it is and keeps its type
 * scope: integrity violations really are scoped to a `media_items` row
 * (`integrity_violations.media_id`), so the browser is the right surface for
 * those. Only the file-level count moves here.
 */
export const ADMIN_FILE_HEALTH_PATH = '/admin/system/health#files';

/**
 * "Items possibly touched around a completed scan" — the scan-run attention
 * item's "items changed since" action.
 *
 * This is a `created_at` filter, not a scan report: `added_since` matches any
 * `media_items` row created after the timestamp, regardless of what created
 * it. A scan that finished during the window did not necessarily create any
 * of the rows it lists — AudiobookShelf and Jellyfin background sync write
 * through the same `created_at` column — and it cannot show the scan's own
 * unmatched files at all, since a file that never became a media item has no
 * row for this filter to find. See the scan-run adapter for why the copy
 * around this link never claims an "items added" count.
 *
 * `domain=everything` + `type=all` follows the same pairing rule
 * `ADMIN_MEDIA_FILE_ISSUES_PATH` documents above: an unpaired domain/type
 * combination renders the wrong filter chips and the wrong stats tiles.
 */
export function buildScanAddedSinceLink(startedAtIso: string): string {
    const params = new URLSearchParams({
        added_since: startedAtIso,
        sort: 'created_at',
        order: 'desc',
        domain: 'everything',
        type: 'all',
    });
    return `/admin/library/media?${params.toString()}`;
}

/**
 * "Music rows with a hygiene finding" — one deep link per finding.
 *
 * Here rather than in `music-hygiene.ts` so that every admin-media deep link
 * in the tree is still spelled in exactly one file, which is the invariant this
 * module exists to hold. The finding vocabulary itself lives in
 * `$lib/shared/music-hygiene.ts` because the server predicates and the
 * browser's `?filter=` parser both need it and neither may import the other.
 *
 * `domain` and `type` come from `MUSIC_HYGIENE_VIEW`, the same map
 * `countMusicHygieneFindings` takes its type scope from — so the list this link
 * opens and the count a badge renders are over one population by construction,
 * not by two call sites agreeing today.
 */
export function buildMusicHygieneLink(finding: MusicHygieneFinding): string {
    const view = MUSIC_HYGIENE_VIEW[finding];
    const params = new URLSearchParams({
        filter: finding,
        domain: view.domain,
        type: view.type,
    });
    return `/admin/library/media?${params.toString()}`;
}
