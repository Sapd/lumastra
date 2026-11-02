// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The symptom catalogue behind `/admin/fix` — the router that turns "no poster
 * on this movie" into the page that can actually answer it.
 *
 * ## Why a catalogue and not a search box
 *
 * A search box only works for someone who already knows the vocabulary. The
 * whole point of this surface is that they do NOT: they know the symptom in
 * their own words and nothing about libraries, tasks, stages or providers. So
 * the index is a plain, finite, ordered LIST of the fourteen symptoms people
 * actually report, phrased the way they report them.
 *
 * ## `kind` is a promise to the operator, not decoration
 *
 * - `diagnostic` — the target page RUNS the checks and shows the result. It
 *   tells the operator what is true about THEIR server right now.
 * - `signpost` — the target page explains where this lives and deep-links
 *   there. It does not check anything.
 *
 * A signpost dressed up as a diagnostic is worse than no page at all: the
 * operator reads a checklist, believes it was checked, and stops looking. The
 * index therefore LABELS each entry from this field (see SymptomList.svelte),
 * and every signpost page carries the same disclaimer. Do not flip an entry to
 * `diagnostic` until its page genuinely queries the running instance.
 */

import type { IconSource } from 'svelte-hero-icons';
import {
    Photo,
    FolderOpen,
    Tv,
    MagnifyingGlass,
    Bolt,
    ChatBubbleBottomCenterText,
    RectangleStack,
    MusicalNote,
    DevicePhoneMobile,
    ExclamationTriangle,
    EyeSlash,
    MagnifyingGlassCircle,
    ArrowsRightLeft,
    ShieldExclamation,
} from 'svelte-hero-icons';
import * as m from '$lib/paraglide/messages.js';

/** Whether the target page checks this instance, or only explains where to look. */
export type SymptomKind = 'diagnostic' | 'signpost';

export interface Symptom {
    /** Stable id — also the last URL segment under `/admin/fix/`. */
    id: string;
    /** Route the entry opens. */
    href: string;
    kind: SymptomKind;
    /** The symptom in the operator's words. Never in ours. */
    title: () => string;
    icon: IconSource;
    /**
     * This symptom has its OWN route directory under `src/routes/admin/fix/`
     * instead of being rendered by the generic `[symptom]` page.
     *
     * The two things are independent of `kind`: `wrong-match` checks nothing
     * (so it is a `signpost`) but still needs a bespoke page, because its whole
     * job is to put a warning above the actions. Making the distinction
     * explicit is what lets `fix-surface.test.ts` assert the exact invariant —
     * every id the `[symptom]` route must serve has catalogue copy in
     * `signposts.ts`, and nothing else does. Without it the relationship was
     * implicit, and deleting a static route would have turned a working page
     * into a 404 with nothing failing first.
     */
    dedicatedRoute?: boolean;
}

/**
 * Display order is deliberate: the two symptoms with real diagnostics behind
 * them sit where they are most likely to be read, and the ordering otherwise
 * follows how often a self-hoster hits them, NOT how the subsystems are laid
 * out internally.
 */
export const SYMPTOMS: readonly Symptom[] = [
    {
        /**
         * FIRST, deliberately. "I added something and it isn't there" is the most
         * common thing an operator arrives with, and until this existed every
         * explainer on the surface required a media UUID — which the operator
         * does not have precisely when the item was never imported. Searching by
         * name is the only entry point that works in the failing case.
         */
        id: 'where-is-it',
        href: '/admin/fix/where-is-it',
        kind: 'diagnostic',
        title: m.admin_symptom_where_is_it,
        icon: MagnifyingGlassCircle,
        dedicatedRoute: true,
    },
    {
        id: 'poster',
        href: '/admin/fix/poster',
        kind: 'signpost',
        title: m.admin_symptom_poster,
        icon: Photo,
    },
    {
        id: 'new-files',
        href: '/admin/fix/new-files',
        kind: 'diagnostic',
        title: m.admin_symptom_new_files,
        icon: FolderOpen,
        dedicatedRoute: true,
    },
    {
        id: 'missing-episodes',
        href: '/admin/fix/missing-episodes',
        kind: 'diagnostic',
        title: m.admin_symptom_missing_episodes,
        icon: Tv,
        dedicatedRoute: true,
    },
    {
        id: 'wrong-match',
        href: '/admin/fix/wrong-match',
        kind: 'signpost',
        title: m.admin_symptom_wrong_match,
        icon: MagnifyingGlass,
        dedicatedRoute: true,
    },
    {
        id: 'slow',
        href: '/admin/fix/slow',
        kind: 'diagnostic',
        title: m.admin_symptom_slow,
        icon: Bolt,
        dedicatedRoute: true,
    },
    {
        /**
         * Sits next to `slow` on purpose: an operator who notices constant
         * transcoding usually arrived via a performance complaint, and this is
         * the per-item companion to that page's host-wide view.
         */
        id: 'why-transcode',
        href: '/admin/fix/why-transcode',
        kind: 'diagnostic',
        title: m.admin_symptom_why_transcode,
        icon: ArrowsRightLeft,
        dedicatedRoute: true,
    },
    {
        id: 'subtitles',
        href: '/admin/fix/subtitles',
        kind: 'signpost',
        title: m.admin_symptom_subtitles,
        icon: ChatBubbleBottomCenterText,
    },
    {
        id: 'seek-previews',
        href: '/admin/fix/seek-previews',
        kind: 'diagnostic',
        title: m.admin_symptom_seek_previews,
        icon: RectangleStack,
        dedicatedRoute: true,
    },
    {
        id: 'music-art',
        href: '/admin/fix/music-art',
        kind: 'signpost',
        title: m.admin_symptom_music_art,
        icon: MusicalNote,
    },
    {
        /**
         * Phrased as the SYMPTOM, not the cause. An operator whose trusted-proxy
         * list is wrong does not know that — they know nobody can sign in. The
         * failure is silent by construction (headers are discarded with no error
         * anywhere), so the page has to be findable from the only thing they can
         * observe.
         */
        id: 'proxy',
        href: '/admin/fix/proxy',
        kind: 'diagnostic',
        title: m.admin_symptom_proxy,
        icon: ShieldExclamation,
        dedicatedRoute: true,
    },
    {
        id: 'stale-clients',
        href: '/admin/fix/stale-clients',
        kind: 'signpost',
        title: m.admin_symptom_stale_clients,
        icon: DevicePhoneMobile,
    },
    {
        /**
         * Not "permissions are wrong" — an operator experiencing this does not
         * yet know permissions are involved. They know one person sees a title
         * and another does not, which is also true of a discovery-only entry
         * where no permission is involved at all.
         */
        id: 'user-cannot-see',
        href: '/admin/fix/user-cannot-see',
        kind: 'diagnostic',
        title: m.admin_symptom_user_cannot_see,
        icon: EyeSlash,
        dedicatedRoute: true,
    },
    {
        id: 'stuck',
        href: '/admin/fix/stuck',
        kind: 'diagnostic',
        title: m.admin_symptom_stuck,
        icon: ExclamationTriangle,
        dedicatedRoute: true,
    },
];

export function findSymptom(id: string): Symptom | undefined {
    return SYMPTOMS.find((s) => s.id === id);
}
