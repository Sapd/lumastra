// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * For You feed section kinds — the single source of truth for per-user feed
 * configuration (which sections of the personalised home feed a user shows or
 * hides).
 *
 * This module is dependency-free and lives in `shared/` so the SAME logic runs
 * on the client (the feed loader + RecommendationFeed + telemetry) and the
 * server (the per-section API short-circuit + SSR), with no drift between the
 * two.
 *
 * WHY KINDS, NOT SECTION IDS:
 * The live feed is assembled client-side from ~13 independent endpoints; section
 * IDs are a mix of STABLE ids (`trending`, `anime`, …) and DYNAMIC per-instance
 * ids (`because-{sourceId}`, `youlike-{keyword}`, `music-because-{id}`,
 * `music-mood-{mood}`, `mood-recommendations-{mood}`). Those dynamic ids change
 * every build, so user preferences MUST key on a normalised KIND token rather
 * than a raw id — otherwise "hide Because You Watched" would only ever match a
 * single stale instance. `sectionKind()` collapses every dynamic family to one
 * stable kind.
 */

/**
 * Canonical, stable section-kind tokens. A user's hide-list and the visibility
 * predicate operate exclusively on these values.
 *
 * Adding a new feed section? Add its kind here AND make sure `sectionKind()`
 * maps the section's id (stable or dynamic-prefixed) onto it.
 */
export const FEED_SECTION_KINDS = [
    'continue-watching',
    'fulfilled-requests',
    'taste',
    'mood-recommendations',
    'featured-pick',
    'because-you-watched',
    'you-like',
    'explore-keywords',
    'short-movies',
    'anime',
    'fresh-releases',
    'binge-worthy',
    'trending',
    'popular-shows',
    'recently-added',
    'random-picks',
    'music-quick-picks',
    // Dynamic music families: `sectionKind()` collapses `music-because-{id}` →
    // 'music-because' and `music-mood-{mood}` → 'music-mood'. Both MUST be
    // registered here so they are user-toggleable AND accepted by the
    // /api/for-you/feedback Zod enum (built from FEED_SECTION_KINDS) — otherwise
    // their impression beacons would fail validation once the rows render.
    'music-because',
    'music-mood',
] as const;

export type FeedSectionKind = (typeof FEED_SECTION_KINDS)[number];

const FEED_SECTION_KIND_SET: ReadonlySet<string> = new Set(FEED_SECTION_KINDS);

/** True when `kind` is one of the known, configurable section kinds. */
export function isFeedSectionKind(kind: string): kind is FeedSectionKind {
    return FEED_SECTION_KIND_SET.has(kind);
}

/**
 * Legacy kind tokens that were RENAMED. Users' hide-lists persist raw tokens in
 * `user_widget_preferences.hidden_section_kinds`, so a rename must keep the old
 * stored token working or every user who hid the section gets it back.
 *
 * Migration strategy is READ-TIME aliasing (not a DB migration): the prefs load
 * path fans out across `loadFeedPrefsForUser`, `GET /api/user/feed-preferences`
 * and layout SSR — a persisted rewrite would mean writing inside read paths.
 * Instead, `normalizeSectionKind` is applied (a) inside `isSectionVisible` so a
 * stored legacy token still hides the renamed kind, and (b) inside
 * `sanitizeHiddenKinds` so the very next SAVE (settings UI or PATCH) persists
 * the canonical token — the stored pref self-migrates on first write.
 *
 * - 'ai-suggestions' → 'taste': the legacy AI-suggestions feed block was
 *   replaced by the strategy-backed taste rail (AI-recs redesign plan 3).
 */
const LEGACY_KIND_ALIASES: Readonly<Record<string, FeedSectionKind>> = {
    'ai-suggestions': 'taste',
};

/** Map a (possibly legacy) kind token to its canonical kind. */
export function normalizeSectionKind(kind: string): string {
    return LEGACY_KIND_ALIASES[kind] ?? kind;
}

/**
 * Sections a user can NEVER hide — hiding these would let someone blank their
 * own home page (and lock themselves out of the two highest-value rows). The
 * settings UI renders them locked, the API strips them from any hide-list on
 * write, and the visibility predicate force-shows them.
 *
 * - `continue-watching` — resume playback (the primary row on the home page).
 * - `fulfilled-requests` — "Your requests are ready" (time-sensitive payoff).
 */
export const ESSENTIAL_FEED_KINDS: readonly FeedSectionKind[] = [
    'continue-watching',
    'fulfilled-requests',
];

/**
 * Under the `minimal` mode the feed shows ONLY these kinds. It is an
 * inverse-allowlist (not a snapshot hide-list) so any section kind added in a
 * future release stays hidden under `minimal` — a user who picked "essentials
 * only" never has to re-hide newly-shipped rows.
 */
export const MINIMAL_VISIBLE_KINDS: readonly FeedSectionKind[] = ESSENTIAL_FEED_KINDS;

export type FeedMode = 'full' | 'minimal' | 'custom';

export const FEED_MODES: readonly FeedMode[] = ['full', 'minimal', 'custom'];

/**
 * The per-user feed preference shape consumed by `isSectionVisible`. Decoupled
 * from the DB row so client and server can both build it cheaply.
 */
export interface FeedPrefs {
    mode: FeedMode;
    /** KIND tokens the user force-hides; only consulted when `mode === 'custom'`. */
    hiddenKinds: readonly string[];
}

/** The back-compat default: show everything, exactly like before this feature. */
export const DEFAULT_FEED_PREFS: FeedPrefs = { mode: 'full', hiddenKinds: [] };

/**
 * Map a section id (stable or dynamic-prefixed) to its stable KIND token.
 *
 * The dynamic prefixes here MUST match the id construction in BOTH the server
 * builder (`section-builder.ts`) and the client loader (`foryou-loader.ts`,
 * which builds `because-${sectionKey}` and suffixes mood ids). A prefix change
 * in either place without updating this function silently un-hides a kind — the
 * unit test pins each prefix to guard against that.
 *
 * Unknown stable ids pass through unchanged (treated as their own kind), so a
 * future section is visible by default until it's added to the registry.
 */
export function sectionKind(id: string): string {
    if (id.startsWith('because-')) return 'because-you-watched';
    if (id.startsWith('youlike-')) return 'you-like';
    if (id.startsWith('music-because-')) return 'music-because';
    if (id.startsWith('music-mood-')) return 'music-mood';
    // Trailing-hyphen symmetry with the other dynamic families: the client
    // suffixes the row as `mood-recommendations-${mood}`; the bare id is the
    // un-suffixed default. Avoids collapsing an unrelated future
    // `mood-recommendations…`-prefixed id into this kind.
    if (id === 'mood-recommendations' || id.startsWith('mood-recommendations-')) {
        return 'mood-recommendations';
    }
    return id;
}

/**
 * Whether a section's OWN ranking consumes the "show less like this" taste
 * damper — i.e. dampening a card in this section actually re-ranks this section.
 * Used to gate the damper context-menu action so it only appears where it has a
 * visible local effect (the hero + featured pick use their own menus and are
 * handled there). Other surfaces (trending, because-you-watched, search, browse,
 * watchlist, …) rank by popularity/recency/their own steering, so the action is
 * hidden there to avoid a "did nothing" feel.
 */
export function sectionConsumesDamper(id: string): boolean {
    const kind = sectionKind(id);
    return (
        kind === 'anime' ||
        kind === 'short-movies' ||
        kind === 'you-like' ||
        kind === 'mood-recommendations'
    );
}

/**
 * The single visibility predicate, used at every enforcement point (client
 * loader skip, client render filter, server endpoint short-circuit).
 *
 * - No prefs / `full` → everything visible (back-compat default).
 * - Essentials → always visible (un-hideable).
 * - `minimal` → only the inverse-allowlist (`MINIMAL_VISIBLE_KINDS`).
 * - `custom` → visible unless the kind is in the user's hide-list.
 */
export function isSectionVisible(kind: string, prefs: FeedPrefs | null | undefined): boolean {
    if (!prefs || prefs.mode === 'full') return true;
    const canonical = normalizeSectionKind(kind);
    if ((ESSENTIAL_FEED_KINDS as readonly string[]).includes(canonical)) return true;
    if (prefs.mode === 'minimal') {
        return (MINIMAL_VISIBLE_KINDS as readonly string[]).includes(canonical);
    }
    // custom — normalize BOTH sides so a stored legacy token (e.g. a hide-list
    // persisted before the 'ai-suggestions' → 'taste' rename) still hides the
    // renamed kind. See LEGACY_KIND_ALIASES.
    return !prefs.hiddenKinds.some((h) => normalizeSectionKind(h) === canonical);
}

/** Convenience: resolve visibility straight from a section id. */
export function isSectionIdVisible(id: string, prefs: FeedPrefs | null | undefined): boolean {
    return isSectionVisible(sectionKind(id), prefs);
}

/**
 * Canonical render order of the "long tail" of algorithmic For-You carousel
 * sections — everything BELOW the fixed-position curated rails (watching
 * strip, mood, featured-pick, fulfilled-requests), which are never reordered.
 * Tokens are the same KIND vocabulary as `FEED_SECTION_KINDS` (via
 * `sectionKind()`), so they line up 1:1 with `user_section_feedback.section_type`
 * rows.
 *
 * This is the DEFAULT order `RecommendationFeed.svelte`'s `sectionsAfterMood`
 * renders in, and the fallback the section-order endpoint returns when
 * `FEATURE_FORYOU_SECTION_RANKER` is off — see `section-ranker.ts`'s
 * `computeSectionOrder()`, which reorders this same list by engagement.
 */
export const FORYOU_LONG_TAIL_ORDER: readonly string[] = [
    'because-you-watched',
    'you-like',
    'taste',
    'explore-keywords',
    'short-movies',
    'anime',
    'fresh-releases',
    'binge-worthy',
    'trending',
    'popular-shows',
    'recently-added',
    'music-quick-picks',
    'music-because',
    'random-picks',
];

/**
 * Normalise a user-supplied hide-list before storage: rewrite legacy renamed
 * tokens to their canonical kind (see LEGACY_KIND_ALIASES — this is the write
 * half of the read-time-alias migration: any save persists the canonical
 * token), drop anything that isn't a known kind, and ALWAYS strip the
 * essentials so a crafted request can never blank a user's home. Pure +
 * order-stable + de-duplicated.
 */
export function sanitizeHiddenKinds(input: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input) {
        const kind = normalizeSectionKind(raw);
        if (!isFeedSectionKind(kind)) continue;
        if ((ESSENTIAL_FEED_KINDS as readonly string[]).includes(kind)) continue;
        if (seen.has(kind)) continue;
        seen.add(kind);
        out.push(kind);
    }
    return out;
}
