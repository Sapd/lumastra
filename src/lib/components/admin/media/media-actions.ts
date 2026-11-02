// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one action registry for admin media items — spec §4.4.
 *
 * Three surfaces used to decide independently which actions an item offers,
 * and disagreed by accident of history rather than by design: delete was
 * bulk-only, play was single-only, and a *persisting* re-probe existed
 * nowhere (`probe-raw` is a non-persisting diagnostic behind a modal).
 * Declaring the set once here is what stops them drifting again.
 *
 * This is applicability rules and scope only — no `execute`, no endpoint
 * wiring, no icons or labels. Those stay at the call sites until the surfaces
 * that consume this registry (inspector, bulk bar) are built.
 */

export type MediaActionId =
    | 'play'
    | 'watch'
    | 'reorder'
    | 'unlock'
    | 'delete'
    | 'syncMetadata'
    | 'syncWithChildren'
    | 'syncImages'
    | 'reprobe'
    | 'identify'
    | 'dismiss';

export type ActionSurface = 'inspector' | 'selection' | 'detail';

/**
 * The `mediaType` a `surface: 'selection'` context carries.
 *
 * A selection is many rows of possibly many types, so there is no single
 * honest value for `ActionContext.mediaType` there. Today that costs nothing:
 * every rule eligible at `surface: 'selection'` ignores `mediaType` outright —
 * the three type-specific rules (`play`, `watch`, `reprobe`) are all
 * `scope: 'item'` — and `media-actions.test.ts` pins that as an invariant
 * rather than leaving it as an assumption the bulk bar quietly relies on.
 *
 * This sentinel exists so the day someone adds a selection-scoped rule that
 * DOES read the type, it reads a value no media type has and fails visibly,
 * instead of silently matching whichever real type the caller happened to
 * pick for the aggregate.
 */
export const MIXED_SELECTION_MEDIA_TYPE = '__mixed-selection__';

export interface ActionContext {
    mediaType: string;
    surface: ActionSurface;
    hasFiles: boolean;
    childCount: number;
    locked: boolean;
    /** Detail-only page state. Absent on the other two surfaces. */
    pageState?: { isSeries: boolean; reorderMode: boolean };
    /** Domain flags the server already resolves for the browser. */
    domainFlags?: { supportsProviderIdentity: boolean; isUnidentified: boolean };
    /**
     * Selection-surface only: something selected is a container whose children
     * a cascading sync would FETCH rather than read.
     *
     * Exists because `childCount` cannot answer that question for a selection.
     * `syncSeriesWithChildren` pulls seasons and episodes from TMDB and needs
     * no existing child rows, so a never-synced series has `childCount: 0` and
     * is precisely the item the action would do the MOST work on. A bulk bar
     * aggregating `childCount` therefore hides the button exactly where it
     * matters most.
     *
     * A flag rather than a media-type check because a selection-scoped rule
     * must not read `ctx.mediaType` — the bulk bar has no honest single value
     * for it and passes `MIXED_SELECTION_MEDIA_TYPE`, an invariant
     * `media-actions.test.ts` pins. The caller answers "is there a cascadable
     * container in here"; the rule stays type-agnostic.
     *
     * Absent on the single-item surfaces, where `childCount` is the item's own
     * and needs no aggregation.
     */
    hasCascadableContainer?: boolean;
}

export interface MediaActionDef {
    id: MediaActionId;
    scope: 'item' | 'selection' | 'both';
    destructive: boolean;
    appliesTo(ctx: ActionContext): boolean;
}

/** Types the in-app watch player can actually open. */
const WATCHABLE_TYPES = new Set(['movie', 'episode']);

/** Music-hierarchy types — artist, album, or track (mirrors `isMusicType`). */
const MUSIC_TYPES = new Set(['artist', 'album', 'track']);

/**
 * Series and seasons — containers today, per WATCHABLE_TYPES above. The
 * list page nonetheless links them to /watch (watch/[itemId]/+page.server.ts
 * imports and handles isSeries/isSeason), so on non-detail surfaces this is
 * a real, working feature, not a bug to fix by narrowing. See the `watch`
 * rule below for why the detail surface does not get it.
 */
const WATCHABLE_CONTAINER_TYPES = new Set(['tv', 'season']);

/**
 * Whether an action's `scope` is even eligible for the given surface, before
 * its own `appliesTo` rule runs. `selection` (the bulk bar) only renders
 * `selection`/`both`-scoped actions; `inspector` and `detail` (both single-
 * item surfaces) only render `item`/`both`-scoped ones.
 */
function scopeMatchesSurface(scope: MediaActionDef['scope'], surface: ActionSurface): boolean {
    if (scope === 'both') return true;
    return surface === 'selection' ? scope === 'selection' : scope === 'item';
}

export const MEDIA_ACTIONS: readonly MediaActionDef[] = [
    {
        id: 'play',
        scope: 'item',
        destructive: false,
        // The music mini-player. Meaningless across a selection (playing
        // forty things at once isn't a thing) — enforced by the 'item' scope
        // above, not by this rule.
        //
        // The two surfaces genuinely differ here, and the difference is
        // INHERITED, not designed: the list page's row action plays any
        // music type with files (`playMusicItem` in media/+page.svelte has
        // real hierarchy-walking logic for albums/artists — shuffles an
        // artist's tracks, plays an album in order), while the detail
        // header has only ever offered it for a track, because an album or
        // artist detail page has its own Tracks/Discography tab instead.
        // Narrowing the list-page behaviour to match the detail page would
        // delete a working feature; widening the detail header would add UI
        // nobody asked for. Keep both, distinguished by surface, until a
        // later task decides to collapse them on purpose.
        appliesTo: (ctx) =>
            ctx.surface === 'detail'
                ? ctx.mediaType === 'track'
                : MUSIC_TYPES.has(ctx.mediaType) && ctx.hasFiles,
    },
    {
        id: 'watch',
        scope: 'item',
        destructive: false,
        // WATCHABLE_TYPES is the primary reason audiobooks never get a watch
        // link — they have no /watch route regardless of hasFiles. hasFiles
        // itself is also always false for an audiobook: their bytes live on
        // the upstream AudiobookShelf server, so the fileSummary load pins
        // their file count to `{ count: 0 }` by design, not because a query
        // happened to come back empty.
        //
        // The surface split below is INHERITED, not designed: the list page
        // additionally links a series/season row straight to /watch
        // regardless of hasFiles (watch/[itemId]/+page.server.ts handles
        // isSeries/isSeason on purpose, so this is a working feature), while
        // the detail header has never offered Watch for anything but a
        // movie/episode with files — a series/album detail page has its own
        // navigation instead. Narrowing the list page to match the detail
        // page, or widening the detail header to match the list page, would
        // both be unrequested behaviour changes; keep the difference visible
        // here so a later task can collapse it on purpose instead of by
        // accident.
        appliesTo: (ctx) =>
            (WATCHABLE_TYPES.has(ctx.mediaType) && ctx.hasFiles) ||
            (ctx.surface !== 'detail' && WATCHABLE_CONTAINER_TYPES.has(ctx.mediaType)),
    },
    {
        id: 'reorder',
        scope: 'item',
        destructive: false,
        // Reorder needs the detail page's own reorderMode state — the other
        // two surfaces never carry `pageState`, so they never offer it.
        appliesTo: (ctx) =>
            ctx.surface === 'detail' && !!ctx.pageState?.isSeries && !ctx.pageState.reorderMode,
    },
    {
        id: 'unlock',
        scope: 'both',
        destructive: false,
        // There is no manual "lock now" action anywhere in this codebase —
        // a lock is only ever a side effect of saving metadata, and the
        // only handler that exists is unlock. Offering it on an item that
        // isn't locked would be an action with nothing to do, so this is
        // the one rule here that DOES read `locked`.
        appliesTo: (ctx) => ctx.locked,
    },
    {
        id: 'delete',
        scope: 'both',
        destructive: true,
        // Item-lifecycle action: available for anything an operator can
        // open, on every surface — it was bulk-only by accident, not by
        // design. `locked` deliberately does NOT gate this one — a lock
        // guards metadata against sync overwrites, not existence — which
        // is why it reads differently from `unlock` right above it.
        appliesTo: () => true,
    },
    {
        id: 'syncMetadata',
        scope: 'both',
        destructive: false,
        // Only meaningful once an item has a provider match to sync
        // against, i.e. not in the unidentified domain.
        appliesTo: (ctx) => !ctx.domainFlags?.isUnidentified,
    },
    {
        id: 'syncWithChildren',
        scope: 'both',
        destructive: false,
        // A cascading sync only makes sense for a container that has children
        // to cascade to — OR one whose children the sync would go and fetch.
        // Those are different questions, and `childCount` only answers the
        // first: a series that has never been synced has no child rows yet,
        // and `syncSeriesWithChildren` pulls its seasons and episodes from
        // TMDB, so it is the case with the MOST work to do rather than the
        // least. `hasCascadableContainer` is how a caller says so; see its
        // doc on ActionContext for why it is a flag and not a type check.
        //
        // `scope` was 'item' when this registry was first written, because at
        // that point the only cascading sync in the codebase was the detail
        // page's. It is 'both' now because a bulk one exists: task 2 shipped
        // POST /api/admin/media/bulk-sync with an `includeChildren` flag, and
        // the bulk action bar is its only caller. Leaving this item-scoped
        // would have forced that bar to hand-roll its own "Sync + Children"
        // button next to the registry-rendered ones — the exact per-surface
        // drift this file exists to stop, and a regression besides, since the
        // bar has offered that button since before the registry existed.
        appliesTo: (ctx) => ctx.childCount > 0 || ctx.hasCascadableContainer === true,
    },
    {
        id: 'syncImages',
        scope: 'both',
        destructive: false,
        // Same provider-match precondition as syncMetadata.
        appliesTo: (ctx) => !ctx.domainFlags?.isUnidentified,
    },
    {
        id: 'reprobe',
        scope: 'item',
        destructive: false,
        // Re-probing reads the item's own local file, so it needs one.
        // Audiobooks are excluded by type as well as by hasFiles: their
        // bytes live on another server (see the `watch` comment above), so
        // there is nothing local to re-probe regardless of what hasFiles
        // happens to read in a given context.
        //
        // ⚠️ NO PERSISTING RE-PROBE ENDPOINT EXISTS. This rule declares an
        // applicability condition, not a capability: the only probe surface
        // in the codebase is POST /api/admin/media/[id]/probe-raw, which is a
        // per-FILE, non-persisting ffprobe diagnostic rendered in a modal on
        // the detail page's Files tab, and it needs a file id that the media
        // browser's rows do not carry (they resolve file PATHS, not ids).
        // /rescan is unrelated — it is Essentia audio analysis for a track.
        //
        // Consequently the surfaces that offer it NAVIGATE to that Files tab
        // rather than probing, and the inspector labels the button "Open
        // Files" so it does not claim otherwise. Do NOT build a second probe
        // path from a list page to make the old label true; if a persisting
        // re-scan is ever wanted, it is a new endpoint plus a new action id,
        // and this rule can then mean what its name says.
        //
        // `scope` is 'item' for the same reason. It was 'both' when this file
        // was written, on the assumption the bulk bar would offer it too; the
        // bar never did, and building it now would mean a button labelled
        // "Open Files" on a forty-row selection that can only navigate to one
        // detail page. There is no bulk probe to offer and single-target
        // navigation is not a selection action, so this narrows the SCOPE
        // rather than inventing a rule at the call site. No button is lost:
        // the bulk bar has never rendered this one.
        appliesTo: (ctx) => ctx.hasFiles && ctx.mediaType !== 'audiobook',
    },
    {
        id: 'identify',
        scope: 'both',
        destructive: false,
        // Only in the unidentified domain, and only for types that can carry
        // a provider match at all (the server resolves which those are).
        appliesTo: (ctx) =>
            !!ctx.domainFlags?.isUnidentified && !!ctx.domainFlags.supportsProviderIdentity,
    },
    {
        id: 'dismiss',
        scope: 'both',
        destructive: true,
        // A hard delete of the unmatched-file mapping, not of a media item —
        // only meaningful in the unidentified domain.
        appliesTo: (ctx) => !!ctx.domainFlags?.isUnidentified,
    },
];

export function actionsFor(ctx: ActionContext): MediaActionDef[] {
    return MEDIA_ACTIONS.filter(
        (action) => scopeMatchesSurface(action.scope, ctx.surface) && action.appliesTo(ctx),
    );
}
