// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin media browser's issue vocabulary: which problems exist, how bad
 * each is, which media types each one applies to, and which saved view lists
 * it.
 *
 * ONE table feeds both halves. The SQL predicates in `admin-media.queries.ts`
 * take their media-type guards from `ISSUE_MEDIA_TYPES`, and
 * `deriveMediaIssues` (the row badges) reads the same table. A view count, the
 * view's list, and the badge on each listed row therefore cannot disagree
 * about which rows have a problem.
 *
 * Why per-type applicability exists at all — prod, 2026-09-27, active items
 * with files: 50,331 of 51,716 episodes have no poster, every track and album
 * has no overview and no TMDB id, every audiobook has no poster blurhash.
 * None of that is a defect: episodes use stills, music is identified by
 * MusicBrainz tags, audiobook covers come from AudiobookShelf. A predicate
 * without the guard turned "Missing artwork" into a list of 50k episodes.
 */

export type MediaIssueKind =
    | 'files_lost'
    | 'file_problem'
    | 'no_tmdb'
    | 'no_poster'
    | 'no_overview'
    | 'duplicate'
    | 'not_in_jellyfin';

export type MediaIssueSeverity = 'error' | 'warn' | 'info';

export const ISSUE_SEVERITY: Readonly<Record<MediaIssueKind, MediaIssueSeverity>> = {
    files_lost: 'error',
    file_problem: 'error',
    no_tmdb: 'warn',
    no_poster: 'warn',
    no_overview: 'warn',
    duplicate: 'warn',
    not_in_jellyfin: 'info',
};

/**
 * Media types a type-sensitive issue applies to. `files_lost` and
 * `file_problem` apply to every type and are absent on purpose.
 *
 * - no_tmdb: only movies and series are identified by TMDB id at the item
 *   level (seasons/episodes inherit it; music never has one).
 * - duplicate: a movie/series file row with no external ids that has a TMDB
 *   discovery twin (same normalized title, year, type). The same pairing as
 *   `findFilelessDuplicatePairsWithTotal`; "two items share one TMDB id"
 *   cannot happen — `external_ids` is UNIQUE on (provider, external_id,
 *   media_type).
 * - no_poster: the types whose card IS a poster. Seasons fall back to the
 *   series poster, episodes use stills, audiobooks carry no blurhash.
 * - no_overview: the types that have a description in the UI.
 * - not_in_jellyfin: Jellyfin sync covers video only. It also needs a local
 *   file (`hasFiles`): a TMDB catalog episode has nothing Jellyfin could hold.
 */
export const ISSUE_MEDIA_TYPES = {
    no_tmdb: ['movie', 'tv'],
    duplicate: ['movie', 'tv'],
    no_poster: ['movie', 'tv', 'album', 'artist'],
    no_overview: ['movie', 'tv', 'episode', 'audiobook'],
    not_in_jellyfin: ['movie', 'tv', 'episode'],
} as const satisfies Partial<Record<MediaIssueKind, readonly string[]>>;

type TypeScopedKind = keyof typeof ISSUE_MEDIA_TYPES;

export function issueAppliesTo(kind: MediaIssueKind, mediaType: string): boolean {
    const types = (ISSUE_MEDIA_TYPES as Partial<Record<MediaIssueKind, readonly string[]>>)[kind];
    return types ? types.includes(mediaType) : true;
}

/** Media types (as a plain array, for a SQL `= ANY(...)` bind) an issue applies to. */
export function issueMediaTypes(kind: TypeScopedKind): string[] {
    return [...ISSUE_MEDIA_TYPES[kind]];
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export const MEDIA_BROWSER_VIEWS = [
    'all',
    'attention',
    'unidentified',
    'artwork',
    'overview',
    'files',
    'duplicates',
    'jellyfin',
    'recent',
    'lost',
] as const;

export type MediaBrowserView = (typeof MEDIA_BROWSER_VIEWS)[number];

/** The issue each problem view lists. `all`, `attention` and `recent` have none. */
export const VIEW_ISSUE: Readonly<Partial<Record<MediaBrowserView, MediaIssueKind>>> = {
    unidentified: 'no_tmdb',
    artwork: 'no_poster',
    overview: 'no_overview',
    files: 'file_problem',
    duplicates: 'duplicate',
    jellyfin: 'not_in_jellyfin',
    lost: 'files_lost',
};

/** The view a badge opens. Every issue kind has exactly one. */
export const ISSUE_VIEW: Readonly<Record<MediaIssueKind, MediaBrowserView>> = {
    no_tmdb: 'unidentified',
    no_poster: 'artwork',
    no_overview: 'overview',
    file_problem: 'files',
    duplicate: 'duplicates',
    not_in_jellyfin: 'jellyfin',
    files_lost: 'lost',
};

export function parseMediaBrowserView(raw: string | null | undefined): MediaBrowserView {
    return (MEDIA_BROWSER_VIEWS as readonly string[]).includes(raw ?? '')
        ? (raw as MediaBrowserView)
        : 'all';
}

export interface ViewScope {
    /** `media_type` values the current domain + type picker resolve to. */
    types: readonly string[];
    /** Jellyfin sync enabled (the `not_in_jellyfin` issue and view exist only then). */
    jellyfinEnabled: boolean;
}

/** Whether an issue kind can occur at all in this scope. */
export function issueInScope(kind: MediaIssueKind, scope: ViewScope): boolean {
    if (kind === 'not_in_jellyfin' && !scope.jellyfinEnabled) return false;
    return scope.types.some((t) => issueAppliesTo(kind, t));
}

/**
 * The views offered in a scope, in display order. A problem view whose issue
 * cannot occur in the scope (Unidentified under Music, Not in Jellyfin with
 * sync off) is left out rather than shown as a permanent zero.
 */
export function viewsForScope(scope: ViewScope): MediaBrowserView[] {
    return MEDIA_BROWSER_VIEWS.filter((v) => {
        const kind = VIEW_ISSUE[v];
        return kind === undefined || issueInScope(kind, scope);
    });
}

/** Problem kinds that count toward "Needs attention" in a scope (info excluded). */
export function attentionKinds(scope: ViewScope): MediaIssueKind[] {
    return (Object.keys(ISSUE_SEVERITY) as MediaIssueKind[]).filter(
        (k) => ISSUE_SEVERITY[k] !== 'info' && issueInScope(k, scope),
    );
}

/** What a view adds to the browser's list/count query options. */
export interface ViewQueryOptions {
    issue?: MediaIssueKind;
    attentionKinds?: MediaIssueKind[];
    /** Force rows without files into the population (Unavailable, Needs attention). */
    includeUnavailable: boolean;
    /** Lower bound on created_at (Recently added). */
    addedSince?: string;
}

/**
 * The single mapping from a view to query options — the page load and the
 * count/list parity test both call it, so they cannot map a view differently.
 */
export function viewQueryOptions(
    view: MediaBrowserView,
    scope: ViewScope,
    now: Date = new Date(),
): ViewQueryOptions {
    if (view === 'attention') {
        return { attentionKinds: attentionKinds(scope), includeUnavailable: true };
    }
    if (view === 'recent') {
        return {
            includeUnavailable: false,
            addedSince: new Date(now.getTime() - RECENT_DAYS * 86400_000).toISOString(),
        };
    }
    const issue = VIEW_ISSUE[view];
    return { issue, includeUnavailable: issue === 'files_lost' };
}

/** "Recently added" window, in days. */
export const RECENT_DAYS = 7;

// ---------------------------------------------------------------------------
// Row badges
// ---------------------------------------------------------------------------

export interface MediaIssue {
    kind: MediaIssueKind;
    severity: MediaIssueSeverity;
    /**
     * For `file_problem`: the recorded health issue type (`truncated_video`,
     * `no_keyframes`, …) or `integrity` for an open integrity violation.
     */
    subtype?: string;
    /** Human-readable reason for the hover, when the source recorded one. */
    detail?: string;
    /** For a series' `file_problem` with subtype `episodes`: how many episodes. */
    count?: number;
}

export interface MediaIssueInput {
    mediaType: string;
    /**
     * The item HAD files and lost them (`files_lost_at` set, `has_files` false).
     * Not the same as `has_files = false`: ~17k active movie/tv rows on prod
     * are TMDB discovery rows that never had a local file, which is normal.
     */
    filesLost: boolean;
    hasTmdb: boolean;
    hasPoster: boolean;
    hasOverview: boolean;
    /** `has_files`: a local file exists (a series rolls its episodes up). */
    hasFiles: boolean;
    jellyfinLinked: boolean;
    isDuplicate: boolean;
    /** Series only: episodes with a file problem (rolled up; the series owns no files). */
    episodeProblems?: number;
    fileIssues?: {
        health: readonly string[];
        healthDetails?: ReadonlyArray<{ type: string; detail?: string; filePath?: string }>;
        integrity: ReadonlyArray<{ rule: string; message?: string | null }>;
    };
}

const SEVERITY_RANK: Record<MediaIssueSeverity, number> = { error: 0, warn: 1, info: 2 };

/**
 * The issues a row shows, most severe first. Pure: the list page and the
 * inspector both call it, and its tests pin the vocabulary.
 */
export function deriveMediaIssues(
    input: MediaIssueInput,
    opts: { jellyfinEnabled: boolean },
): MediaIssue[] {
    const out: MediaIssue[] = [];
    const push = (kind: MediaIssueKind, extra: Partial<MediaIssue> = {}): void => {
        out.push({ kind, severity: ISSUE_SEVERITY[kind], ...extra });
    };
    const t = input.mediaType;

    if (input.filesLost) push('files_lost');
    for (const type of input.fileIssues?.health ?? []) {
        const first = input.fileIssues?.healthDetails?.find((d) => d.type === type);
        const detail = [first?.detail, first?.filePath].filter(Boolean).join(' — ') || undefined;
        push('file_problem', { subtype: type, detail });
    }
    if ((input.episodeProblems ?? 0) > 0) {
        push('file_problem', { subtype: 'episodes', count: input.episodeProblems });
    }
    if ((input.fileIssues?.integrity.length ?? 0) > 0) {
        const firstMessage = input.fileIssues?.integrity.find((i) => i.message)?.message;
        push('file_problem', { subtype: 'integrity', detail: firstMessage ?? undefined });
    }
    if (!input.hasTmdb && issueAppliesTo('no_tmdb', t)) push('no_tmdb');
    if (input.isDuplicate && issueAppliesTo('duplicate', t)) push('duplicate');
    if (!input.hasPoster && issueAppliesTo('no_poster', t)) push('no_poster');
    if (!input.hasOverview && issueAppliesTo('no_overview', t)) push('no_overview');
    if (
        opts.jellyfinEnabled &&
        input.hasFiles &&
        !input.jellyfinLinked &&
        issueAppliesTo('not_in_jellyfin', t)
    ) {
        push('not_in_jellyfin');
    }

    // Stable sort: within a severity, the push order above is the display order.
    return out
        .map((issue, i) => ({ issue, i }))
        .sort(
            (a, b) =>
                SEVERITY_RANK[a.issue.severity] - SEVERITY_RANK[b.issue.severity] || a.i - b.i,
        )
        .map(({ issue }) => issue);
}

/**
 * Info-severity issues are notes about an integration, not problems with the
 * media: surfaces render them muted, apart from the problem badges, and they
 * never open a season or count on a grid card.
 */
export function isIssueNote(issue: MediaIssue): boolean {
    return issue.severity === 'info';
}

export function problemIssues(issues: readonly MediaIssue[]): MediaIssue[] {
    return issues.filter((i) => !isIssueNote(i));
}

export function noteIssues(issues: readonly MediaIssue[]): MediaIssue[] {
    return issues.filter(isIssueNote);
}
