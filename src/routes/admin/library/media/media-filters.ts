// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { viewsForScope, parseMediaBrowserView } from '$lib/shared/media-issues.js';
import {
    isMusicHygieneFinding,
    MUSIC_HYGIENE_FINDINGS,
    type MusicHygieneFinding,
} from '$lib/shared/music-hygiene.js';

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Admin media-browser filter resolution.
 *
 * Lives in a sibling module rather than in `+page.server.ts` because SvelteKit
 * route files may only export reserved names (`load`, `actions`, …) — `vite
 * build` enforces that even though `svelte-check`/`vitest` do not. Keeping the
 * pure mappers here also makes them directly unit-testable.
 *
 * The pairing between the two functions is load-bearing: `inferDomain` picks the
 * domain a bare `?type=` deep-link lands in, and `resolveTypes` must produce the
 * matching `media_type` set for that domain. A type filter that resolves to a
 * type set but infers the wrong domain renders the wrong filter chips and the
 * wrong stats tiles (see `+page.svelte`, `domainTypeFilters`).
 */

/**
 * Sort keys `+page.server.ts` will accept from `?sort=`, and the only keys any
 * client-side helper here may name.
 *
 * Lives in this module rather than as a `const` inside `load` because a route
 * file may only export reserved names: declared there it could not be imported,
 * so `+page.server.ts`, the `SortCol` union in `+page.svelte` and the test
 * asserting `defaultSortForType` stays inside the whitelist each kept their own
 * hand-copy — three lists that drift silently, since nothing compares them.
 *
 * `admin-media.queries.ts` maps these onto real columns (plus the two named
 * groupings `namedOrder()` handles); an unlisted value falls back to `title`
 * there, which is a silent wrong answer rather than an error — hence the
 * explicit gate in `load`.
 */
export const VALID_SORT_COLS = [
    'title',
    'year',
    'created_at',
    'updated_at',
    'artist',
    'hierarchy',
] as const;

/** A sort key the server accepts. Derived from the list, never re-typed. */
export type SortCol = (typeof VALID_SORT_COLS)[number];

/** Music-hierarchy `media_type` values, grouped behind the `music` filter. */
export const MUSIC_TYPES = ['artist', 'album', 'track'] as const;

/** Non-entertainment `media_type` values, grouped behind the `other_all` filter. */
export const OTHER_TYPES = ['home_video', 'training', 'educational', 'personal'] as const;

/**
 * Audiobook `media_type` values — a TOP-LEVEL peer of `music`, deliberately not
 * folded into `OTHER_TYPES`.
 *
 * `ENTERTAINMENT_LIBRARY_TYPES` (`$lib/shared/media-types`) already declares
 * `audiobook` a peer of `music`, and the admin browser is the only sanctioned
 * hard-delete path for AudiobookShelf-sourced rows: the ingest sweep *dismisses*
 * books that vanish upstream rather than purging them, so without a reachable
 * audiobook filter an operator has no escape hatch short of `psql`.
 */
export const AUDIOBOOK_TYPES = ['audiobook'] as const;

/**
 * `media_type` values covered by the `all` ("Everything") filter.
 *
 * Still not literally every value the `media_items` CHECK allows — see
 * `NON_BROWSABLE_TYPES` below, which `media-filters.test.ts` asserts partitions
 * `INTERNAL_MEDIA_TYPES` exactly with this list. That partition is the point:
 * every omission this file has shipped (audiobooks, then extras) was a type
 * nobody classified rather than a type anybody decided to hide.
 *
 * `extra` is here because a trailer or featurette is a real file that can carry
 * a real `truncated_video`. While it was omitted, `?type=all` — the widest scope
 * this browser offers — could not list one under any circumstances, so an
 * operator had no way to find or delete a broken extra at all. (The file-health
 * BADGE no longer links here; it counts `media_files` rows, which is a different
 * population — see `ADMIN_FILE_HEALTH_PATH`. This is about the browser being
 * complete, not about reconciling that count.)
 */
export const ALL_BROWSABLE_TYPES: readonly string[] = [
    'movie',
    'tv',
    'episode',
    'season',
    'extra',
    ...MUSIC_TYPES,
    ...AUDIOBOOK_TYPES,
    ...OTHER_TYPES,
];

/**
 * `media_type` values the browser deliberately does NOT list, each with the
 * reason it is excluded rather than merely forgotten.
 *
 * Exists so the test can assert an exhaustive partition of
 * `INTERNAL_MEDIA_TYPES`. A new media type then fails the suite the moment it is
 * added, forcing a classification — instead of silently defaulting to
 * unreachable, which is how `audiobook` and `extra` each went missing for
 * months.
 */
export const NON_BROWSABLE_TYPES: readonly string[] = [
    // Live TV / radio streams: no `media_files` rows, no local identity to fix.
    // Owned by /admin/livetv.
    'tvchannel',
    'radio',
    // Enterprise showcase catalog, published via its own surface; no writer for
    // these lives in this tree.
    'product',
    // Reading formats with no ingest path here yet — nothing ever writes a row.
    'book',
    'manga',
    'comic',
    'podcast',
    // Vocabulary aliases and request/integration markers, not library rows.
    'audio',
    'music',
    'anfragen',
    'sonarr',
    'radarr',
];

/** Resolve which `media_type` values the type filter maps to. */
export function resolveTypes(typeFilter: string, domain?: string): string[] {
    // Unidentified domain: type filter narrows within unidentified items
    if (domain === 'unidentified') {
        switch (typeFilter) {
            case 'movie':
            case 'tv':
                return [typeFilter];
            case 'unidentified_all':
            default:
                return ['movie', 'tv']; // only types where TMDB identification matters
        }
    }
    switch (typeFilter) {
        case 'tv':
        case 'movie':
        case 'episode':
        case 'season':
        case 'home_video':
        case 'training':
        case 'educational':
        case 'personal':
        case 'artist':
        case 'album':
        case 'track':
        case 'audiobook':
            return [typeFilter];
        case 'music':
            return [...MUSIC_TYPES];
        case 'other_all':
            return [...OTHER_TYPES];
        case 'all':
            return [...ALL_BROWSABLE_TYPES];
        case 'main':
        default:
            return ['movie', 'tv'];
    }
}

/**
 * Default type filter for a domain, used when `?domain=` arrives without `?type=`
 * (a bookmarked or hand-edited URL — the tab buttons always send both).
 *
 * Mirrors `domainDefaults` in `+page.svelte`. Without it every such URL fell back
 * to `'main'` → `['movie','tv']`, so `?domain=audiobook` would render the
 * Audiobooks tab over a list of films. Kept next to `resolveTypes` so the default
 * and the resolution it feeds cannot drift apart.
 */
export function defaultTypeForDomain(domain: string): string {
    switch (domain) {
        // Artists, NOT the `music` group filter. The group filter interleaves
        // artists, albums and tracks sorted by title: on a real catalogue that
        // is 31,809 rows over 637 pages with zero artists on page one, because
        // tracks outnumber artists ~50:1. Artists alone is 642 rows.
        case 'music':
            return 'artist';
        case 'audiobook':
            return 'audiobook';
        case 'other':
            return 'other_all';
        case 'everything':
            return 'all';
        case 'unidentified':
            return 'unidentified_all';
        default:
            return 'main';
    }
}

/**
 * Type filter for a SEARCH that arrives without `?type=`. The Music default
 * (Artists) exists to keep the unsearched list browsable, but a search scoped to
 * it can never find an album or track: matches expand down to children, never
 * up to the artist. A search orders by relevance, so the 50:1 track flood that
 * motivated the Artists default does not apply — search the whole group.
 * An explicitly chosen type (`?type=artist` from the picker) still wins.
 */
export function defaultSearchTypeForDomain(domain: string): string {
    return domain === 'music' ? 'music' : defaultTypeForDomain(domain);
}

/** Infer domain from type filter when no explicit domain is provided. */
export function inferDomain(typeFilter: string): string {
    switch (typeFilter) {
        case 'music':
        case 'artist':
        case 'album':
        case 'track':
            return 'music';
        // Audiobooks get their own domain, not 'other': `other`'s type set is
        // OTHER_TYPES, so falling through would resolve the wrong media types
        // and render the wrong filter chips.
        case 'audiobook':
            return 'audiobook';
        case 'home_video':
        case 'training':
        case 'educational':
        case 'personal':
        case 'other_all':
            return 'other';
        case 'all':
            return 'everything';
        case 'unidentified_all':
            return 'unidentified';
        case 'file_health':
            return 'file_health';
        case 'integrity':
            return 'integrity';
        case 'quarantine':
            return 'quarantine';
        default:
            return 'video';
    }
}

/**
 * Advanced-filter keys, in render order, that every domain offers.
 *
 * Kept as one list with per-domain subtraction rather than per-domain lists so a
 * filter added later is offered everywhere by default — the failure mode of the
 * inverse (a new filter silently missing from a domain nobody re-checked) is the
 * one that produced the unreachable `audiobook` type in the first place.
 */
const ALL_ADVANCED_FILTER_KEYS = [
    'missing_tmdb',
    'missing_jf',
    'missing_poster',
    'missing_overview',
    'has_embedding',
    'locked',
    'local_only',
    'custom_poster',
] as const;

/**
 * Filter keys that only mean something for an item a metadata provider
 * identifies.
 *
 * `has_embedding` sits here with the two id filters because the embedding
 * pipeline is fed from provider metadata: an audiobook has no embedding row and
 * never will, so the filter reads "all of them" forever — the same
 * always-100%-missing uselessness as the TMDB counter this replaces.
 */
const PROVIDER_IDENTITY_FILTER_KEYS = ['missing_tmdb', 'missing_jf', 'has_embedding'] as const;

/**
 * Whether a domain's items are identified by an external metadata provider.
 *
 * Drives the Status column's TMDB/Jellyfin dots, the TMDB column and the
 * provider-identity advanced filters. False for audiobooks (identified by their
 * AudiobookShelf item id) and for music (identified by tags + MusicBrainz), both
 * of which would otherwise render a permanently red "missing TMDB" dot on every
 * single row.
 */
export function domainSupportsProviderIdentity(domain: string): boolean {
    return domain !== 'audiobook' && domain !== 'music';
}

/** Whether the list should offer the author/narrator/series columns. */
export function domainShowsBookColumns(domain: string): boolean {
    return domain === 'audiobook';
}

/** Advanced-filter keys to render for a domain, in order. */
export function advancedFilterKeysForDomain(domain: string): readonly string[] {
    if (domainSupportsProviderIdentity(domain)) return ALL_ADVANCED_FILTER_KEYS;
    return ALL_ADVANCED_FILTER_KEYS.filter(
        (key) => !(PROVIDER_IDENTITY_FILTER_KEYS as readonly string[]).includes(key),
    );
}

/**
 * Strip filter params a domain does not offer, in place.
 *
 * Load-bearing on every domain switch, not just cosmetic. Hiding a filter's
 * checkbox does not clear its query param, so an operator who ticks "Missing
 * TMDB ID" under Video and then clicks Audiobooks would carry `?missing_tmdb=1`
 * into a domain where no row can ever match it — an empty list, and no visible
 * chip to explain it because the chip is hidden too.
 *
 * `library` is dropped for EVERY domain, which is why it comes before the
 * provider-identity early return rather than after it. A library group holds
 * exactly ONE media type, so a group picked while browsing Video or Music
 * cannot contain a single audiobook — carried across, it narrows the target
 * domain to nothing, always. This rule used to live as a lone `library: ''` in
 * `setDomain`'s `buildUrl` call in `+page.svelte`, where no unit test reached
 * it and deleting the line would have looked like tidying up.
 *
 * Dropping beats "keep it if the group's types match the new domain". The
 * membership answer would have to come from `mediaTypes` on the library group,
 * and a match test would be relying on that array being both populated and
 * complete for every group. It is neither, historically: file-less groups used
 * to report nothing at all because `getLibraryGroupsWithCounts` reached items
 * only through `media_files`. That specific hole is now closed — such a group
 * reports its real types via the direct `media_items.library_group_id`
 * fallback — but the rule stands on the invariant, not on the data: ONE media
 * type per group means a carried-over group is always wrong for a new domain,
 * whatever `mediaTypes` happens to hold.
 */
export function pruneFiltersForDomain(params: URLSearchParams, domain: string): void {
    params.delete('library');
    if (domainSupportsProviderIdentity(domain)) return;
    for (const key of PROVIDER_IDENTITY_FILTER_KEYS) {
        params.delete(key);
    }
}

/** Ancestry column slots. `Root` is the top of the chain, `Parent` the level below it. */
export type AncestryColumnKey = 'ancestryParent' | 'ancestryRoot';

/** Semantic label ids. The component maps these to Paraglide messages. */
export type AncestryLabelKey = 'album' | 'artist' | 'season' | 'series' | 'parent' | 'root';

/**
 * The column heading for an ancestry slot.
 *
 * A `switch` here rather than the `Record<AncestryLabelKey, () => string>` that
 * used to live in `+page.svelte`: nothing in this repo checks a lookup map
 * written inside a component. `npm run typecheck` runs tsgo, which does not read
 * `.svelte` at all, and `npm run check` (svelte-check-native) was MEASURED on
 * 2026-08-27 not to flag a renamed key in a component-local `Record<Union, …>`
 * either. The page called the result immediately — `ANCESTRY_LABELS[key]()` in
 * four template slots — so a seventh label key added here would not have
 * mislabelled a column, it would have thrown on `undefined` and taken the whole
 * media-browser table header with it.
 *
 * Same reasoning, and same shape, as `musicHygieneChipLabel` at the bottom of
 * this file. Do not fold either back into a record literal.
 */
export function ancestryLabel(key: AncestryLabelKey): string {
    switch (key) {
        case 'album':
            return m.media_col_album();
        case 'artist':
            return m.media_col_artist();
        case 'season':
            return m.media_col_season();
        case 'series':
            return m.media_col_tv_series();
        case 'parent':
            return m.media_col_parent();
        case 'root':
            return m.media_col_root();
    }
}

export interface AncestryPlan {
    parent: AncestryLabelKey | null;
    root: AncestryLabelKey | null;
}

/**
 * Which ancestry columns a view offers, and what to call them.
 *
 * Keyed on (domain, typeFilter) rather than on domain alone because there is no
 * "episode domain": `inferDomain('episode')` is `'video'`, the same domain the
 * movies view uses. A domain-only gate cannot tell them apart, and the movies
 * view must not sprout a Season column.
 */
export function ancestryPlanFor(_domain: string, typeFilter: string): AncestryPlan {
    // `_domain` is underscore-prefixed deliberately: the answer turns out to be
    // decidable from the type alone, but the parameter stays in the signature
    // because callers pass (domain, typeFilter) everywhere and a future
    // domain-sensitive case would otherwise change every call site.
    // `@typescript-eslint/no-unused-vars` is an ERROR here with
    // argsIgnorePattern '^_', so the prefix is load-bearing, not cosmetic.
    switch (typeFilter) {
        case 'track':
            return { parent: 'album', root: 'artist' };
        case 'album':
            return { parent: 'artist', root: null };
        case 'episode':
            return { parent: 'season', root: 'series' };
        case 'season':
            return { parent: 'series', root: null };
        case 'music':
            // The "All Music" chip mixes hierarchy levels (artist + album +
            // track rows) exactly like Everything does, just scoped to music,
            // so the columns get generic names and the component fills each
            // cell from whichever ancestry field is set on the row.
            return { parent: 'parent', root: 'root' };
        case 'all':
            // Types are mixed here, so the columns get generic names and the
            // component fills each cell from whichever ancestry field is set.
            return { parent: 'parent', root: 'root' };
        default:
            // Root types (artist, movie, tv, audiobook) and mixed root-only
            // views (`main` = movie+tv) have no ancestry to show.
            return { parent: null, root: null };
    }
}

/**
 * Types that can never have children, so a child-count column is always `—`.
 *
 * The criterion is "can a row of this type EVER be a `parent_id` target in this
 * schema", verified per type against the writers — NOT "usually doesn't". A
 * sparse-but-real count that the column hides is the same defect as the
 * populated `year` this file once suppressed on tracks (see `YEARLESS_TYPES`):
 * the operator has no way to discover the data exists. A column reading `—` on
 * most rows is the acceptable cost, and the picker can switch it off.
 *
 * `child_count` is an unfiltered `COUNT(*)` over `c.parent_id = mi.id`
 * (`admin-media.queries.ts`), so `extra` rows count like any other child.
 * `processExtra` resolves an extra's parent through `findMediaItemByFilePath`,
 * `findParentMediaItemByFolder` or `findRootMediaItemByFolderRecursive`
 * (`media-files.queries.ts`) — all three constrain only `media_type != 'extra'`,
 * so ANY type owning a `media_files` row can end up a parent:
 *
 * - `movie` — a sibling `Film-trailer.mkv` matches the film's own file.
 * - `episode` — same shape inside a season folder (`S01E01-trailer.mkv` →
 *   `S01E01.mkv`), and `findParentMediaItemByFolder` on a season folder returns
 *   an episode outright. So an episode with a trailer has a real count.
 * - `track` — `walkExtras` applies its `hasPrimaryVideo` gate only to sibling
 *   suffix-extras; the `EXTRAS_FOLDER_MAP` subfolder branch is ungated and
 *   `walkExtras` runs on EVERY library path, music included. A video under
 *   `Artist/Album/featurettes/` resolves its parent from the album folder,
 *   whose files belong to track rows (`attachFileToItem(sql, fileId, trackId)`,
 *   `audio-processor.ts`). Rare, but reachable.
 * - `home_video` / `personal` / `training` / `educational` — ordinary video
 *   items in scanned libraries, so the extras paths reach them too; the two
 *   course-style types additionally parent season rows outright
 *   (`hierarchyMode: 'series'` → `findOrCreateSeriesHierarchy`).
 *
 * `audiobook` is the one genuine leaf. `insertAudiobook`
 * (`audiobooks.queries.ts`) is its only writer, it sets no `parent_id`, and
 * audiobook rows carry NO `media_files` rows at all by design
 * (`FILELESS_BY_DESIGN_MEDIA_TYPES`) — every parent-resolution query above
 * joins through `media_files`, so none can ever return one.
 */
const LEAF_TYPES = new Set(['audiobook']);

/**
 * Types where `year` is never populated, so the column is always `—`.
 *
 * `track` is deliberately NOT here: the scanner writes a year on every track it
 * inserts — see `audio-processor.ts`, `insertScannedMediaItem({ mediaType:
 * 'track', year: effectiveYear })` where `effectiveYear = tags.year ??
 * extractYearFromFolder(albumDir)`. Listing it hid the Year column from the
 * Tracks view AND from the column picker (this gate feeds both), which also
 * made `sortUrl('year')` unreachable there — the header is its only call site.
 *
 * `artist` genuinely belongs: `findOrCreateMusicArtist` inserts (title,
 * media_type, library_group_id, is_various_artists) and no year, ever.
 */
const YEARLESS_TYPES = new Set(['artist']);

/**
 * Whether a column means anything in the view currently being browsed.
 *
 * Separate from the operator's visibility preference on purpose: a choice to
 * show the TMDB column is about the video views, and should survive a trip
 * through Audiobooks rather than being silently rewritten by it.
 */
export function columnAppliesTo(key: string, domain: string, typeFilter: string): boolean {
    if (BOOK_COLUMN_KEYS.includes(key)) return domainShowsBookColumns(domain);
    if (PROVIDER_IDENTITY_COLUMN_KEYS.includes(key)) return domainSupportsProviderIdentity(domain);

    const plan = ancestryPlanFor(domain, typeFilter);
    if (key === 'ancestryParent') return plan.parent !== null;
    if (key === 'ancestryRoot') return plan.root !== null;

    if (key === 'fileCount') return ['main', 'movie', 'all'].includes(typeFilter);
    if (key === 'children') return !LEAF_TYPES.has(typeFilter);
    if (key === 'year') return !YEARLESS_TYPES.has(typeFilter);

    return true;
}

/**
 * Header for the child-count column, named after what the count IS in a
 * single-type view: a series' children are seasons, an album's are tracks.
 * "Children" is the tree's vocabulary, not the operator's — it stays only for
 * mixed views, where one header has to cover several kinds of child.
 *
 * A switch over message calls, not a record literal, for the reason spelled
 * out on `ancestryLabel`.
 */
export function childrenColumnLabel(typeFilter: string): string {
    switch (typeFilter) {
        case 'tv':
            return m.seasons();
        case 'season':
            return m.episodes();
        case 'artist':
            return m.route_admin_media_filter_albums();
        case 'album':
            return m.media_tracks_heading();
        case 'movie':
        case 'episode':
            return m.modal_extras_section();
        default:
            return m.media_col_children();
    }
}

/** Columns that only apply to the audiobook domain. */
const BOOK_COLUMN_KEYS = ['author', 'narrator', 'series'];

/** Columns that only apply where an external metadata provider identifies the item. */
const PROVIDER_IDENTITY_COLUMN_KEYS = ['tmdb'];

/**
 * The sort a view lands on when the URL carries no `?sort=`.
 *
 * Per TYPE, never per domain. Artist rows have no ancestry at all, so a
 * domain-wide "music sorts by artist" would leave the artist landing view
 * ordered only by the `mi.id` tiebreak — arbitrary order on the default view.
 *
 * A→Z is kept wherever it is genuinely the useful order (root types), and
 * replaced by a grouping wherever a flat alphabetical list of child rows is
 * unreadable.
 */
export function defaultSortForType(typeFilter: string): { sort: SortCol; order: 'asc' | 'desc' } {
    switch (typeFilter) {
        // `season` sits with track/episode, and its own `ancestrySortKeyFor`
        // already said `hierarchy` — the two disagreed, and the consistency test
        // papered over it by excluding `season` from its loop. A season-only
        // type set makes `namedOrder()`'s `isTvOnly` true, so `hierarchy` groups
        // by `series_title` then `season_number`; the alternative it replaces
        // was a flat A→Z list of "Season 1" repeated once per show — exactly the
        // unreadable child-row listing these per-type defaults exist to kill.
        case 'track':
        case 'episode':
        case 'season':
            return { sort: 'hierarchy', order: 'asc' };
        case 'album':
            return { sort: 'artist', order: 'asc' };
        default:
            return { sort: 'title', order: 'asc' };
    }
}

/**
 * The direction a column sorts in on its FIRST click, before any toggling.
 *
 * Lived in `+page.svelte` as a `Record<SortCol, 'asc' | 'desc'>` — the fourth
 * hand-copy of `VALID_SORT_COLS`, and the one nothing checked: tsgo skips
 * `.svelte`, and svelte-check-native does not flag a broken key in a
 * component-local record. A seventh sort column would have produced
 * `?order=undefined` in the header links, which `load` rejects back to the
 * default — a header that silently refuses to sort the way it says it does.
 *
 * `hierarchy` and `artist` are groupings rather than rankings: `namedOrder()`
 * in admin-media.queries.ts emits a fixed ascending multi-column ORDER BY for
 * them and ignores sortDir, so they never toggle (see `isGroupingSort`).
 */
export function defaultSortDirFor(col: SortCol): 'asc' | 'desc' {
    switch (col) {
        case 'title':
            return 'asc';
        case 'year':
        case 'created_at':
        case 'updated_at':
            return 'desc';
        case 'artist':
        case 'hierarchy':
            return 'asc';
    }
}

/** What the URL should do with a `sort` or `order` param. */
export type SortUrlAction =
    { action: 'keep' } | { action: 'delete' } | { action: 'set'; value: string };

/**
 * What a `sort`/`order` URL param should become, given the value the caller
 * asked for and whether this navigation changes which VIEW is being browsed.
 *
 * Owns both rules governing these two params, because they interact and a
 * caller applying one without the other reintroduces a shipped bug:
 *
 * RULE A — an explicitly requested value is always encoded, never stripped for
 * matching a default. `buildUrl()` used to drop `sort`/`order` whenever they
 * equaled a single global default (`title`/`asc`). That is unsound now the
 * default is per TYPE (`defaultSortForType`): on Tracks/Episodes/Seasons/Albums
 * an ABSENT `sort` means "use `hierarchy`/`artist`", so stripping `sort=title`
 * there does not mean "sort by title" — it silently reroutes the view back to
 * its grouping and the Title header goes inert. Comparing against the current
 * type's resolved default instead would put a second copy of
 * `defaultSortForType`'s mapping in the client, which then drifts.
 *
 * RULE B — a view change DELETES them, and outranks rule A. They were chosen
 * for the view being LEFT, and letting them fall away is what lets the server's
 * per-type default reassert itself. Load-bearing precisely BECAUSE of rule A,
 * and because `sort`/`order` are in `PERSISTED_FILTER_PARAMS`: one click on the
 * Title header under Tracks would otherwise write `sort=title` to localStorage,
 * ride into Episodes, and render 49,022 rows flat alphabetical (two shows both
 * reading "001") for good. Worse carrying `sort=year` out of Movies into
 * `type=artist`, where every row is NULL so the order collapses to the `mi.id`
 * tiebreak — and the Year header is hidden there, so there is no indicator and
 * no way to undo it.
 *
 * `keep` (rather than `delete`) for an unrequested value on a same-view
 * navigation is what lets paging, searching and filter toggles preserve the
 * sort the operator picked.
 */
export function resolveSortUrlParam(
    requested: string | undefined,
    viewChanging: boolean,
): SortUrlAction {
    // Rule B first: it outranks an explicit request, so a hypothetical future
    // caller passing a sort alongside a type switch cannot smuggle a stale key
    // into the new view.
    if (viewChanging) return { action: 'delete' };
    if (requested === undefined) return { action: 'keep' };
    // Rule A: any non-empty value is encoded as-is. Only an explicitly empty
    // request clears the param.
    if (requested === '') return { action: 'delete' };
    return { action: 'set', value: requested };
}

/**
 * Sort keys that express a GROUPING rather than a ranking.
 *
 * `namedOrder()` in `admin-media.queries.ts` emits a fixed multi-column
 * ascending ORDER BY for these and ignores `sortDir` entirely, so a descending
 * "group by artist" does not exist server-side. The header must therefore not
 * offer a direction toggle for them — a second click that flipped `order` to
 * `desc` would change the URL and re-render an identically-ordered table.
 */
const GROUPING_SORT_KEYS: readonly string[] = ['hierarchy', 'artist'];

/** Whether a sort key is a grouping, so its header must not toggle direction. */
export function isGroupingSort(sort: string): boolean {
    return GROUPING_SORT_KEYS.includes(sort);
}

/**
 * The sort key the ancestry column headers link to, or null where no grouping
 * applies.
 *
 * Without this the named sorts were reachable ONLY as a per-type default: no
 * `sortUrl()` call site emitted `hierarchy` or `artist`, so one click on any
 * other header left the operator with no way back to the grouping, and on the
 * grouped views no header lit up at all (every indicator gates on
 * `data.sort === <btree column>`) — the table read as unsorted.
 *
 * Mirrors `defaultSortForType`'s choices deliberately: a header that lands on a
 * different key than the view's own default would make the default look
 * un-selected on arrival.
 *
 * `all` (the "Everything" view) returns null: its type set spans both the TV
 * and music hierarchies, so `namedOrder()` has no single hierarchy to group by
 * and falls through to plain title order. A clickable header there would claim
 * a grouping the query cannot deliver.
 */
export function ancestrySortKeyFor(domain: string, typeFilter: string): string | null {
    const plan = ancestryPlanFor(domain, typeFilter);
    if (plan.parent === null && plan.root === null) return null;
    switch (typeFilter) {
        case 'album':
            return 'artist';
        case 'track':
        case 'episode':
        case 'season':
        case 'music':
            return 'hierarchy';
        default:
            return null;
    }
}

/**
 * The single-value `?filter=` vocabulary.
 *
 * ONE param carrying one value, not a `?x=1` toggle per finding. The browser
 * already has eight boolean advanced-filter params; a ninth through a twelfth
 * for the music-hygiene findings would be four more things
 * `pruneFiltersForDomain`, the chip list and `PERSISTED_FILTER_PARAMS` each have
 * to know about, and four more ways for a stale param to ride into a domain
 * where nothing can match it. A single-value param has exactly one state to
 * clear.
 *
 * The music-hygiene values are imported rather than re-spelled: the server
 * predicates key off the same union, and a hand-copy here would let a badge
 * link to a value the load does not parse — an unfiltered list under a filtered
 * heading, with nothing failing anywhere.
 */
export const FILTER_FILE_ISSUES = 'file-issues';

/** Every value `?filter=` accepts. */
export const MEDIA_BROWSER_FILTER_VALUES: readonly string[] = [
    FILTER_FILE_ISSUES,
    ...MUSIC_HYGIENE_FINDINGS,
];

/**
 * What a `?filter=` value resolves to for the query layer.
 *
 * Both fields are always present so a caller cannot forget one: an unknown or
 * absent value yields "no filter", never a thrown error — a bookmarked URL from
 * a future version must degrade to an unfiltered list, not a 500.
 */
export interface ResolvedBrowserFilter {
    /** `?filter=file-issues` — items whose files have health or integrity issues. */
    fileIssues: boolean;
    /** `?filter=music-…` — one music-hygiene finding, or null. */
    musicHygiene: MusicHygieneFinding | null;
}

/** Resolve the raw `?filter=` value into the flags the load passes to the queries. */
export function resolveBrowserFilter(raw: string | null | undefined): ResolvedBrowserFilter {
    return {
        fileIssues: raw === FILTER_FILE_ISSUES,
        musicHygiene: isMusicHygieneFinding(raw) ? raw : null,
    };
}

/**
 * The active-filter chip label for a music-hygiene finding.
 *
 * A `switch` over the union in a `.ts` module, NOT a `Record` literal in
 * `+page.svelte`, and the difference is load-bearing rather than stylistic:
 * `npm run typecheck` (tsgo) does not read `.svelte` files at all, and
 * `svelte-check-native` was measured NOT to flag a mistyped key in a
 * `Record<MusicHygieneFinding, string>` inside a component. So a map living in
 * the component is checked by nothing — verified, not assumed. Here, a missing
 * case makes the function return `string | undefined` and a mistyped case label
 * is not comparable to the union; both are hard tsgo errors.
 *
 * That matters because these four value strings are a contract with three other
 * places (the server predicates, `buildMusicHygieneLink`, and `?filter=`
 * parsing) and a typo throws nowhere — it just drops the chip, leaving an
 * operator who arrived from a badge on a narrowed list with nothing saying why.
 *
 * `music-artist-unsplit` says "(heuristic)" in its copy. "X & Y" is a real
 * collaboration as often as it is one act's name ("Above & Lanterns"), and
 * `custom_metadata.no_split` only suppresses a row after an operator marks it,
 * so this list always contains correct rows; copy that read like a defect list
 * would be lying to the person clearing it. The caveat is baked into the
 * translated string rather than composed here, so
 * `isHeuristicMusicHygieneFinding` cannot gate it — `page.svelte.test.ts`
 * asserts the correspondence instead.
 *
 * `music-title-from-filename` says "matches", not "was taken from": the
 * predicate is an equality, and in a library named from its own tags the
 * equality holds in both directions.
 */
export function musicHygieneChipLabel(finding: MusicHygieneFinding): string {
    switch (finding) {
        case 'music-track-no-artist':
            return m.admin_media_chip_music_track_no_artist();
        case 'music-album-no-artist':
            return m.admin_media_chip_music_album_no_artist();
        case 'music-title-from-filename':
            return m.admin_media_chip_music_title_from_filename();
        case 'music-artist-unsplit':
            return m.admin_media_chip_music_artist_unsplit();
    }
}

// ---------------------------------------------------------------------------
// Page size, layout, A–Z jump (triage spec §5–6)
// ---------------------------------------------------------------------------

/** Page sizes the browser offers; anything else falls back to the first. */
export const PAGE_SIZES = [50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/**
 * Cookies, not localStorage: the server renders the page, so a remembered page
 * size or layout read client-side would render the default first and then
 * flash to the stored one.
 */
export const PAGE_SIZE_COOKIE = 'admin_media_page_size';
export const LAYOUT_COOKIE = 'admin_media_layout';

export type BrowserLayout = 'list' | 'grid';

export function parsePageSize(raw: string | null | undefined): PageSize {
    const n = Number(raw);
    return (PAGE_SIZES as readonly number[]).includes(n) ? (n as PageSize) : PAGE_SIZES[0];
}

export function parseLayout(raw: string | null | undefined): BrowserLayout {
    return raw === 'grid' ? 'grid' : 'list';
}

/** The A–Z bar's targets. `#` is "before A" — digits and punctuation — i.e. page 1. */
export const JUMP_LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] as const;

/** A valid `?jump=` value, or null. */
export function parseJumpLetter(raw: string | null | undefined): string | null {
    const up = (raw ?? '').toUpperCase();
    return (JUMP_LETTERS as readonly string[]).includes(up) ? up : null;
}

/** Keep a saved URL's view consistent with the domain/type controls. */
export function normalizeRestoredView(params: URLSearchParams, jellyfinEnabled: boolean): void {
    const domain = params.get('domain') ?? inferDomain(params.get('type') ?? 'main');
    const type =
        params.get('type') ??
        (params.get('q') ? defaultSearchTypeForDomain(domain) : defaultTypeForDomain(domain));
    const available = viewsForScope({ types: resolveTypes(type, domain), jellyfinEnabled });
    if (!available.includes(parseMediaBrowserView(params.get('view')))) params.delete('view');
}
