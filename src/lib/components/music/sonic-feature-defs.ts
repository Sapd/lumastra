// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared sonic-feature definitions — single source of truth used by both
 * MusicFeatureTiles (the ERKUNDEN grid on /music) and MusicSubpageHeader
 * (the feature-switcher pill row on all 7 sonic sub-pages).
 *
 * The array is static; each consumer creates its own $derived to evaluate
 * `.enabled` using `$page.data?.features`, keeping this module free of
 * Svelte/store dependencies.
 */

import { GlobeAlt, ArrowsRightLeft, QueueList, Beaker } from 'svelte-hero-icons';
import { RadioTower } from '$lib/components/admin/navigation/lumastra-custom-icons';
import type { IconSource } from 'svelte-hero-icons';

/**
 * Minimal shape of the features object from $page.data.features that the
 * sonic feature defs need.  Mirrors the relevant subset of the global
 * AppFeatures interface in src/app.d.ts without importing it (it's a global,
 * not an exported type).
 */
export interface SonicPageFeatures {
    musicMap?: boolean;
    sonicEmbeddings?: boolean;
    musicClusters?: boolean;
    textToSound?: boolean;
    lyricsSearch?: boolean;
    musicAlchemy?: boolean;
    /**
     * Data-derived (not a config flag): true iff ≥1 radio station
     * (media_type = 'radio') is configured on the server. Set by the root
     * layout load. Gates the Radio nav pill + Explore tile.
     */
    musicRadio?: boolean;
}

export interface SonicFeatureDef {
    /** Route href — e.g. '/music/map' */
    href: string;
    /** Returns the localised label string (paraglide message fn called at runtime) */
    label: () => string;
    /** Returns the localised description string */
    description: () => string;
    /** Icon component from svelte-hero-icons or a local icon module */
    icon: IconSource;
    /**
     * Given the features object from `$page.data?.features`, returns whether
     * this feature is currently enabled. Radio is data-driven: enabled only
     * when `musicRadio === true` (≥1 radio station configured).
     */
    enabled: (features: SonicPageFeatures | undefined) => boolean;
    /**
     * Optional: this surface is best on desktop (e.g. the Music Map's pan/zoom/
     * lasso canvas has no good touch equivalent). The tile shows a "best on
     * desktop" hint on coarse-pointer (touch) devices only.
     */
    desktopBest?: boolean;
}

// Import messages lazily so this module works even before paraglide compiles.
// The functions are called at render time, not at import time.
import * as m from '$lib/paraglide/messages.js';

export const SONIC_FEATURE_DEFS: SonicFeatureDef[] = [
    {
        href: '/music/map',
        label: () => m.music_feature_map_label(),
        description: () => m.music_feature_map_desc(),
        icon: GlobeAlt,
        enabled: (f) => f?.musicMap === true,
        desktopBest: true,
    },
    {
        href: '/music/path',
        label: () => m.music_feature_path_label(),
        description: () => m.music_feature_path_desc(),
        icon: ArrowsRightLeft,
        enabled: (f) => f?.sonicEmbeddings === true,
    },
    {
        href: '/music/collections',
        label: () => m.music_feature_collections_label(),
        description: () => m.music_feature_collections_desc(),
        icon: QueueList,
        enabled: (f) => f?.musicClusters === true,
    },
    {
        href: '/music/alchemy',
        label: () => m.music_feature_mixing_desk_label(),
        description: () => m.music_feature_mixing_desk_desc(),
        icon: Beaker,
        enabled: (f) => f?.musicAlchemy === true,
    },
    {
        href: '/music/radio',
        label: () => m.music_feature_radio_label(),
        description: () => m.music_feature_radio_desc(),
        icon: RadioTower,
        enabled: (f) => f?.musicRadio === true,
    },
];
