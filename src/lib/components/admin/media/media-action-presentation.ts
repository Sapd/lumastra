// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Label and icon for every `MediaActionId`, for the surfaces that render the
 * registry in `media-actions.ts`.
 *
 * A sibling module rather than part of the registry itself: `media-actions.ts`
 * is deliberately applicability rules and scope only, and importing icon
 * components into it would drag a UI dependency into the one file the rule
 * tests exercise. This module is the presentation half of the same contract.
 *
 * WHY IT IS A SWITCH AND NOT A `Record<MediaActionId, …>`
 *
 * It was a `Record<MediaActionId, string>` in each of MediaActionBar.svelte and
 * MediaInspector.svelte, with a comment in the bar claiming a newly registered
 * action would be "a compile error here rather than a button with a blank
 * face". That claim was false. `npm run typecheck` runs tsgo, which does not
 * read `.svelte` at all, and `npm run check` (svelte-check-native) was MEASURED
 * on 2026-08-27 not to flag a renamed key in a component-local
 * `Record<Union, …>` either — 2025 files, 0 errors with a deliberately broken
 * map. So the three hand-copies compiled clean, and a twelfth action would have
 * rendered in the bulk bar as an icon-less, label-less button sitting in a
 * toolbar whose other members include Delete.
 *
 * A `switch` in a `.ts` module IS checked, and by tsgo specifically: a missing
 * case fails the declared return type (no ending return statement), and a
 * mistyped case fails as not comparable to `MediaActionId`. Do not "simplify"
 * these back into a record literal — a `Record` in a `.ts` file catches the
 * missing case but not a case that no longer exists, and a `Record` in a
 * `.svelte` file catches nothing at all.
 */

import * as m from '$lib/paraglide/messages.js';
import {
    ArrowPath,
    ArrowDownOnSquare,
    ArrowsUpDown,
    DocumentText,
    Eye,
    LockOpen,
    Photo,
    Play,
    Tag,
    Trash,
    XCircle,
    type IconSource,
} from 'svelte-hero-icons';
import type { MediaActionId } from './media-actions.js';

/**
 * The button label, in full.
 *
 * `reprobe` reads "Open Files" and not "Re-probe" on purpose: no persisting
 * re-probe endpoint exists anywhere in this codebase (see the rule's own
 * comment in `media-actions.ts`), so the handler navigates to the detail
 * page's Files tab. A button reading "Re-probe" that navigates instead of
 * probing is a lie about what pressing it does.
 */
export function mediaActionLabel(id: MediaActionId): string {
    switch (id) {
        case 'play':
            return m.media_plain_play();
        case 'watch':
            return m.media_plain_watch();
        case 'reorder':
            return m.media_plain_reorder();
        case 'unlock':
            return m.media_plain_allow_updates();
        case 'delete':
            return m.media_plain_delete();
        case 'syncMetadata':
            return m.media_plain_refresh_details();
        case 'syncWithChildren':
            return m.media_plain_refresh_contents();
        case 'syncImages':
            return m.media_plain_refresh_artwork();
        case 'reprobe':
            return m.media_plain_open_files();
        case 'identify':
            return m.media_plain_choose_match();
        case 'dismiss':
            return m.media_plain_hide();
    }
}

/**
 * The label for the bulk bar, which lays its buttons out in one horizontal row
 * and cannot afford the longest wording.
 *
 * The `default` arm is deliberate and safe: it forwards to
 * `mediaActionLabel`, which IS exhaustive, so a newly registered action still
 * gets a real label here — it simply gets the full one until someone decides
 * it needs shortening. Only ids whose full label is too wide belong above it.
 */
export function mediaActionShortLabel(id: MediaActionId): string {
    switch (id) {
        case 'syncWithChildren':
            return m.media_plain_refresh_contents();
        default:
            return mediaActionLabel(id);
    }
}

/** The button's leading icon. Total over `MediaActionId` — see the module doc. */
export function mediaActionIcon(id: MediaActionId): IconSource {
    switch (id) {
        case 'play':
            return Play;
        case 'watch':
            return Eye;
        case 'reorder':
            return ArrowsUpDown;
        case 'unlock':
            return LockOpen;
        case 'delete':
            return Trash;
        case 'syncMetadata':
            return ArrowPath;
        case 'syncWithChildren':
            return ArrowDownOnSquare;
        case 'syncImages':
            return Photo;
        case 'reprobe':
            return DocumentText;
        case 'identify':
            return Tag;
        case 'dismiss':
            return XCircle;
        default: {
            // This arm, NOT the return type, is what makes this switch total.
            // MEASURED 2026-08-27: deleting a case from `mediaActionLabel`
            // (returns `string`) is 1 tsgo error, and deleting one from here was
            // ZERO — `IconSource` is `{ default: … } & { [theme: string]: … }`,
            // and that index signature is enough for tsgo to accept a
            // fall-off-the-end return. A return-type-based exhaustiveness guard
            // is only ever as strong as the return type, so the icon switch gets
            // an explicit `never` assignment instead.
            //
            // Unreachable by construction: every caller passes an id that came
            // out of `actionsFor()`, i.e. out of `MEDIA_ACTIONS`.
            const unhandled: never = id;
            throw new Error(`Unhandled MediaActionId: ${String(unhandled)}`);
        }
    }
}
