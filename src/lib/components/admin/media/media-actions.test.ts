// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    actionsFor,
    MEDIA_ACTIONS,
    MIXED_SELECTION_MEDIA_TYPE,
    type ActionContext,
} from './media-actions.js';

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
    mediaType: 'movie',
    surface: 'inspector',
    hasFiles: true,
    childCount: 0,
    locked: false,
    ...over,
});

describe('scope', () => {
    it('never offers play to a selection — playing forty things is meaningless', () => {
        expect(
            actionsFor(ctx({ surface: 'selection', mediaType: 'track' })).map((a) => a.id),
        ).not.toContain('play');
        expect(
            actionsFor(ctx({ surface: 'inspector', mediaType: 'track' })).map((a) => a.id),
        ).toContain('play');
    });

    it('offers delete on every surface — it was bulk-only by accident', () => {
        for (const surface of ['inspector', 'selection', 'detail'] as const) {
            expect(actionsFor(ctx({ surface })).map((a) => a.id)).toContain('delete');
        }
    });

    it('offers syncWithChildren only where there are children', () => {
        expect(actionsFor(ctx({ mediaType: 'tv', childCount: 5 })).map((a) => a.id)).toContain(
            'syncWithChildren',
        );
        expect(
            actionsFor(ctx({ mediaType: 'movie', childCount: 0 })).map((a) => a.id),
        ).not.toContain('syncWithChildren');
    });
});

describe('media-type rules', () => {
    it('offers watch to a movie or episode that has files, on every eligible surface', () => {
        expect(actionsFor(ctx({ mediaType: 'movie' })).map((a) => a.id)).toContain('watch');
        expect(
            actionsFor(ctx({ mediaType: 'movie', hasFiles: false })).map((a) => a.id),
        ).not.toContain('watch');
        expect(
            actionsFor(ctx({ mediaType: 'movie', surface: 'detail' })).map((a) => a.id),
        ).toContain('watch');
        // A bare 'tv' (series) is NOT covered by this rule — see
        // 'surface-inherited differences' below, where it differs by surface
        // on purpose (inherited from the list page, not a media-type rule).
    });

    it('never offers re-probe to an audiobook — its bytes are on another server', () => {
        expect(actionsFor(ctx({ mediaType: 'audiobook' })).map((a) => a.id)).not.toContain(
            'reprobe',
        );
    });

    it('offers unlock only when the item is locked', () => {
        expect(actionsFor(ctx({ locked: true })).map((a) => a.id)).toContain('unlock');
        expect(actionsFor(ctx({ locked: false })).map((a) => a.id)).not.toContain('unlock');
    });

    it('offers reorder only on a series detail page that is not already reordering', () => {
        const p = (reorderMode: boolean) =>
            ctx({ surface: 'detail', mediaType: 'tv', pageState: { isSeries: true, reorderMode } });
        expect(actionsFor(p(false)).map((a) => a.id)).toContain('reorder');
        expect(actionsFor(p(true)).map((a) => a.id)).not.toContain('reorder');
        expect(
            actionsFor(ctx({ surface: 'inspector', mediaType: 'tv' })).map((a) => a.id),
        ).not.toContain('reorder');
    });
});

describe('surface-inherited differences', () => {
    // watch and play each differ between the detail header and the other two
    // surfaces (inspector, selection) — not because anyone designed it that
    // way, but because the list page's row actions and the detail header's
    // control row already disagreed before this registry existed, and both
    // sides turned out to be real, working behaviour (task-1-report.md,
    // findings 1-2). Narrowing either surface to match the other would have
    // deleted a feature, so the split is carried into the registry as-is,
    // gated explicitly on `surface`, rather than resolved.

    it('offers watch for a series/season row on non-detail surfaces, but never on the detail header', () => {
        for (const mediaType of ['tv', 'season']) {
            expect(actionsFor(ctx({ mediaType, surface: 'inspector' })).map((a) => a.id)).toContain(
                'watch',
            );
            // The list page's row link has no hasFiles gate for a container —
            // unlike the movie/episode branch just above, which does.
            expect(
                actionsFor(ctx({ mediaType, surface: 'inspector', hasFiles: false })).map(
                    (a) => a.id,
                ),
            ).toContain('watch');
            expect(
                actionsFor(ctx({ mediaType, surface: 'detail' })).map((a) => a.id),
            ).not.toContain('watch');
        }
    });

    it('offers play for any music type with files on non-detail surfaces, but only a track on the detail header', () => {
        for (const mediaType of ['artist', 'album']) {
            expect(actionsFor(ctx({ mediaType, surface: 'inspector' })).map((a) => a.id)).toContain(
                'play',
            );
            // Unlike watch's container carve-out above, play still needs files —
            // playMusicItem has nothing to play from an artist/album with none.
            expect(
                actionsFor(ctx({ mediaType, surface: 'inspector', hasFiles: false })).map(
                    (a) => a.id,
                ),
            ).not.toContain('play');
            expect(
                actionsFor(ctx({ mediaType, surface: 'detail' })).map((a) => a.id),
            ).not.toContain('play');
        }
        expect(
            actionsFor(ctx({ mediaType: 'track', surface: 'detail' })).map((a) => a.id),
        ).toContain('play');
    });
});

describe('registry integrity', () => {
    it('has no duplicate ids', () => {
        const ids = MEDIA_ACTIONS.map((a) => a.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('marks exactly the irreversible actions destructive', () => {
        const destructive = MEDIA_ACTIONS.filter((a) => a.destructive)
            .map((a) => a.id)
            .sort();
        expect(destructive).toEqual(['delete', 'dismiss']);
    });
});

// Additional coverage beyond the brief's minimum list, for the rules found
// while reconciling against the list page's Actions column and bulk bar
// (media/+page.svelte) — see task-1-report.md for the full reconciliation.
describe('domain rules', () => {
    it('offers identify only in the unidentified domain, for types that support provider identity', () => {
        const withFlags = (isUnidentified: boolean, supportsProviderIdentity: boolean) =>
            ctx({ domainFlags: { isUnidentified, supportsProviderIdentity } });
        expect(actionsFor(withFlags(true, true)).map((a) => a.id)).toContain('identify');
        expect(actionsFor(withFlags(true, false)).map((a) => a.id)).not.toContain('identify');
        expect(actionsFor(withFlags(false, true)).map((a) => a.id)).not.toContain('identify');
    });

    it('offers dismiss only in the unidentified domain, regardless of media type', () => {
        expect(
            actionsFor(
                ctx({ domainFlags: { isUnidentified: true, supportsProviderIdentity: false } }),
            ).map((a) => a.id),
        ).toContain('dismiss');
        expect(
            actionsFor(
                ctx({ domainFlags: { isUnidentified: false, supportsProviderIdentity: true } }),
            ).map((a) => a.id),
        ).not.toContain('dismiss');
    });

    it('withholds syncMetadata and syncImages in the unidentified domain — nothing to sync against yet', () => {
        const unidentified = ctx({
            domainFlags: { isUnidentified: true, supportsProviderIdentity: true },
        });
        expect(actionsFor(unidentified).map((a) => a.id)).not.toContain('syncMetadata');
        expect(actionsFor(unidentified).map((a) => a.id)).not.toContain('syncImages');
        expect(actionsFor(ctx()).map((a) => a.id)).toContain('syncMetadata');
        expect(actionsFor(ctx()).map((a) => a.id)).toContain('syncImages');
    });
});

// The bulk action bar (task 6) is the second consumer of this registry, and it
// asks a question the single-item surfaces never do: what applies to MANY rows
// at once. These pin the two scope decisions that answer differ on, plus the
// invariant its aggregate context depends on.
describe('the selection surface', () => {
    const selection = (over: Partial<ActionContext> = {}) =>
        ctx({ surface: 'selection', mediaType: MIXED_SELECTION_MEDIA_TYPE, ...over });

    it('offers syncWithChildren to a selection — bulk-sync takes includeChildren', () => {
        // Revert-check: set `syncWithChildren`'s scope back to 'item' and this
        // fails. The bar would then have to hand-roll the button, which is the
        // drift the registry exists to prevent.
        expect(actionsFor(selection({ childCount: 12 })).map((a) => a.id)).toContain(
            'syncWithChildren',
        );
        expect(actionsFor(selection({ childCount: 0 })).map((a) => a.id)).not.toContain(
            'syncWithChildren',
        );
    });

    /**
     * `childCount > 0` is the wrong question for a cascading sync:
     * `syncSeriesWithChildren` FETCHES seasons and episodes from TMDB and
     * needs no existing child rows, so a never-synced series has a count of 0
     * and is the item with the MOST work to do.
     *
     * Revert-check: drop `|| ctx.hasCascadableContainer === true` from the
     * rule and the first assertion fails.
     */
    it('offers syncWithChildren for a container whose children would be FETCHED', () => {
        expect(
            actionsFor(selection({ childCount: 0, hasCascadableContainer: true })).map((a) => a.id),
        ).toContain('syncWithChildren');
        expect(
            actionsFor(selection({ childCount: 0, hasCascadableContainer: false })).map(
                (a) => a.id,
            ),
        ).not.toContain('syncWithChildren');
    });

    /**
     * The flag is selection-surface plumbing. The single-item surfaces never
     * set it, and must keep behaving exactly as they did — `childCount` there
     * is the item's own and needs no aggregation.
     *
     * Revert-check: change the rule to `ctx.hasCascadableContainer !== false`
     * (i.e. default-on) and this fails.
     */
    it('leaves the single-item surfaces on childCount alone', () => {
        for (const surface of ['inspector', 'detail'] as const) {
            expect(
                actionsFor(ctx({ surface, mediaType: 'tv', childCount: 0 })).map((a) => a.id),
            ).not.toContain('syncWithChildren');
            expect(
                actionsFor(ctx({ surface, mediaType: 'tv', childCount: 5 })).map((a) => a.id),
            ).toContain('syncWithChildren');
        }
    });

    it('never offers reprobe to a selection — there is no bulk probe', () => {
        // Revert-check: set `reprobe`'s scope back to 'both' and this fails —
        // the bar grows an "Open Files" button that can only navigate to one
        // of the forty selected rows.
        expect(actionsFor(selection({ hasFiles: true })).map((a) => a.id)).not.toContain('reprobe');
        // Still offered where it means something: one item, one Files tab.
        expect(
            actionsFor(ctx({ surface: 'inspector', mediaType: 'movie', hasFiles: true })).map(
                (a) => a.id,
            ),
        ).toContain('reprobe');
    });

    /**
     * The bulk bar builds ONE aggregate `ActionContext` for a selection that
     * may hold many media types, and passes `MIXED_SELECTION_MEDIA_TYPE` for a
     * field that has no honest aggregate value. That is only safe while no
     * selection-eligible rule reads `mediaType`. This is that guarantee, held
     * here rather than as a comment in the bar.
     *
     * Revert-check: change any selection-eligible rule to read `ctx.mediaType`
     * (e.g. give `delete` an `appliesTo` of `ctx.mediaType !== 'movie'`) and
     * this fails, naming the type that made the difference.
     */
    it('has no selection-eligible rule that reads the media type', () => {
        const types = [
            MIXED_SELECTION_MEDIA_TYPE,
            'movie',
            'tv',
            'season',
            'episode',
            'track',
            'album',
            'artist',
            'audiobook',
            'extra',
        ];
        const baseline = actionsFor(selection()).map((a) => a.id);
        for (const mediaType of types) {
            expect({
                mediaType,
                ids: actionsFor(selection({ mediaType })).map((a) => a.id),
            }).toEqual({ mediaType, ids: baseline });
        }
    });
});
