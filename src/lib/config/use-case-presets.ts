// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { configSchema } from './schema';

export type UseCaseId = 'vod' | 'music' | 'enterprise' | 'showcase';

export interface PresetCapabilities {
    hasEmbeddings: boolean;
    hasSonicEmbedder: boolean;
}

export interface UseCasePreset {
    id: UseCaseId;
    label: string;
    primaryModeCandidate: UseCaseId;
    primaryRank: number; // lower = higher precedence
    landingPath: string;
    libraryTypes: string[];
    enable: string[];
    disable: string[];
    taskSwitches: Record<string, boolean>;
    extraConfig: Record<string, string | boolean | string[]>;
    capabilityEnable: { embeddings: string[]; sonicEmbedder: string[] };
}

export interface ApplyResult {
    patch: Record<string, string | boolean | string[]>;
    /**
     * Keys of `patch` a selected preset (or the orchestration) explicitly
     * sets, as opposed to the schema baseline written for the rest. These are
     * the profile's choices: they are kept in settings.json even when equal to
     * today's default, so a later default change does not undo them.
     */
    requestedKeys: string[];
    primaryMode: UseCaseId;
    landingPath: string;
    libraryTypes: string[];
}

const MUSIC_CLUSTER = [
    'FEATURE_MUSIC_ALCHEMY',
    'FEATURE_MUSIC_SONIC',
    'FEATURE_MUSIC_MAP',
    'FEATURE_MUSIC_LYRICS_SEARCH',
    'FEATURE_MUSIC_CLUSTERS',
    'FEATURE_MUSIC_TEXT_SOUND',
    'FEATURE_MUSIC_SONIC_TASTE',
    'FEATURE_MUSIC_SONIC_QUEUE',
];

export const USE_CASE_PRESETS: Record<UseCaseId, UseCasePreset> = {
    showcase: {
        id: 'showcase',
        label: 'Product Showcase',
        primaryModeCandidate: 'showcase',
        primaryRank: 3, // lowest precedence; vod=0 still wins in any mixed selection
        landingPath: '/library/product',
        libraryTypes: ['product'],
        enable: [],
        disable: [
            'FEATURE_AI_RECOMMENDATIONS',
            'FEATURE_AI_ASSISTANT',
            'FEATURE_TRENDING',
            'FEATURE_YOUTUBE_MODALS',
            'FEATURE_YOUTUBE_HERO',
            'FEATURE_MEDIA_HOVER_POPUP_TRAILERS',
            'FEATURE_CALENDAR',
            'FEATURE_LIVETV',
            'FEATURE_AUDIOBOOKS',
            'FEATURE_KAVITA',
            'FEATURE_GRAVATAR',
            'FEATURE_AUTO_LYRICS',
            'FEATURE_MUSIC_LYRICS_FETCH',
            'FEATURE_SAVE_LYRICS_TO_DISK',
            'FEATURE_SOCIAL',
            'FEATURE_SOCIAL_REVIEWS',
            'FEATURE_PERSONAL_STATS',
            'FEATURE_MUSIC_TRANSCODE',
            'FEATURE_MUSIC_CLUSTERING',
            'FEATURE_REQUEST_MODAL',
            ...MUSIC_CLUSTER,
        ],
        taskSwitches: {
            PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED: false,
            DISABLE_MUSIC_ANALYSIS: true,
            DISABLE_FRIBB_ANIME_SYNC: true,
            DISABLE_MAL_ANIME_ENRICHMENT: true,
            DISABLE_CURATED_LISTS_SYNC: true,
            DISABLE_HOLIDAY_RECOMMENDATIONS: true,
            // Keep file scanning + probing + trickplay on so uploaded product videos work.
            DISABLE_FILE_LIBRARY_SCAN: false,
            DISABLE_MEDIA_PROBE: false,
            DISABLE_LOCAL_TRICKPLAY: false,
            DISABLE_TRICKPLAY_PARAMS: false,
        },
        extraConfig: {
            SHOW_UNAVAILABLE_MEDIA: false,
            // Master switch for the public /showcase surface.
            // Switching away from the showcase preset resets this to OFF (deny-by-default).
            FEATURE_PUBLIC_SHOWCASE: true,
            // Default: link/token-shared (per resolved decision). Explicit opt-out for fully-open.
            SHOWCASE_REQUIRE_TOKEN: true,
        },
        capabilityEnable: { embeddings: [], sonicEmbedder: [] },
    },
    vod: {
        id: 'vod',
        label: 'Movies & TV (VOD)',
        primaryModeCandidate: 'vod',
        primaryRank: 0,
        landingPath: '/',
        libraryTypes: ['movie', 'tv', 'anime'],
        enable: [
            'FEATURE_AI_RECOMMENDATIONS',
            'FEATURE_TRENDING',
            'FEATURE_YOUTUBE_MODALS',
            'FEATURE_YOUTUBE_HERO',
            'FEATURE_MEDIA_HOVER_POPUP',
            'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW',
            'FEATURE_FEATURED_PICK_VIDEO',
            'FEATURE_SHOW_UNAIRED_EPISODES',
            'FEATURE_SHOW_MISSING_EPISODES',
            'FEATURE_CALENDAR',
            'FEATURE_SOCIAL',
            'FEATURE_PERSONAL_STATS',
        ],
        disable: [],
        taskSwitches: {
            PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED: true,
            DISABLE_CURATED_LISTS_SYNC: false,
            DISABLE_FRIBB_ANIME_SYNC: false,
            DISABLE_MAL_ANIME_ENRICHMENT: false,
        },
        extraConfig: { SHOW_UNAVAILABLE_MEDIA: true },
        capabilityEnable: { embeddings: [], sonicEmbedder: [] },
    },
    music: {
        id: 'music',
        label: 'Music',
        primaryModeCandidate: 'music',
        primaryRank: 1,
        landingPath: '/music',
        libraryTypes: ['music'],
        enable: [
            'FEATURE_MUSIC_TRANSCODE',
            'FEATURE_AUTO_LYRICS',
            'FEATURE_PLAYLISTS',
            'FEATURE_MUSIC_CLUSTERING',
            'FEATURE_PERSONAL_STATS',
            'FEATURE_SOCIAL',
        ],
        disable: [
            // A music-first instance shouldn't surface the video/discovery chrome.
            // (Music's own features — playlists, social, lyrics, personal-stats,
            // AI recs, the sonic suite — are enabled above / via capabilities.)
            'FEATURE_LIVETV',
            'FEATURE_REQUEST_MODAL',
            'FEATURE_TRENDING',
            'FEATURE_CALENDAR',
            'FEATURE_YOUTUBE_MODALS',
            'FEATURE_YOUTUBE_HERO',
            'FEATURE_MEDIA_HOVER_POPUP_TRAILERS',
            'FEATURE_FEATURED_PICK_VIDEO',
            'FEATURE_SHOW_UNAIRED_EPISODES',
            'FEATURE_SHOW_MISSING_EPISODES',
            'FEATURE_AUDIOBOOKS',
            'FEATURE_KAVITA',
        ],
        taskSwitches: {
            DISABLE_MUSIC_ANALYSIS: false,
            PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED: false,
        },
        extraConfig: { FEATURE_MUSIC_FIRST: true },
        capabilityEnable: {
            embeddings: ['FEATURE_AI_RECOMMENDATIONS', 'FEATURE_MUSIC_LYRICS_SEARCH'],
            sonicEmbedder: MUSIC_CLUSTER,
        },
    },
    enterprise: {
        id: 'enterprise',
        label: 'Home Videos / Training / Enterprise',
        primaryModeCandidate: 'enterprise',
        primaryRank: 2,
        landingPath: '/library/home_video',
        libraryTypes: ['home_video', 'training', 'educational', 'personal'],
        // The LMS is the core of the enterprise/training use case — turn it on so a
        // fresh enterprise box has working /admin/{courses,quizzes,trainings,reporting}
        // + /my/trainings out of the box (otherwise every LMS route 302-redirects until
        // an admin flips the flags). FEATURE_PUBLIC_SHOWCASE stays its own 'showcase'
        // preset (a distinct, public surface) — pick both presets for an enterprise
        // instance that also wants a public product showcase.
        enable: ['FEATURE_AVATAR_UPLOAD', 'FEATURE_ASSESSMENT', 'FEATURE_TRAINING_ASSIGNMENTS'],
        disable: [
            'FEATURE_AI_RECOMMENDATIONS',
            'FEATURE_AI_ASSISTANT',
            'FEATURE_TRENDING',
            'FEATURE_YOUTUBE_MODALS',
            'FEATURE_YOUTUBE_HERO',
            'FEATURE_MEDIA_HOVER_POPUP_TRAILERS',
            'FEATURE_CALENDAR',
            'FEATURE_LIVETV',
            'FEATURE_AUDIOBOOKS',
            'FEATURE_KAVITA',
            'FEATURE_GRAVATAR',
            'FEATURE_AUTO_LYRICS',
            'FEATURE_MUSIC_LYRICS_FETCH',
            'FEATURE_SAVE_LYRICS_TO_DISK',
            'FEATURE_SOCIAL',
            'FEATURE_SOCIAL_REVIEWS',
            'FEATURE_PERSONAL_STATS',
            'FEATURE_MUSIC_TRANSCODE',
            'FEATURE_MUSIC_CLUSTERING',
            ...MUSIC_CLUSTER,
        ],
        taskSwitches: {
            PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED: false,
            DISABLE_MUSIC_ANALYSIS: true,
            DISABLE_FRIBB_ANIME_SYNC: true,
            DISABLE_MAL_ANIME_ENRICHMENT: true,
            DISABLE_CURATED_LISTS_SYNC: true,
            DISABLE_HOLIDAY_RECOMMENDATIONS: true,
            DISABLE_FILE_LIBRARY_SCAN: false,
            DISABLE_MEDIA_PROBE: false,
            DISABLE_LOCAL_TRICKPLAY: false,
            DISABLE_TRICKPLAY_PARAMS: false,
        },
        extraConfig: { SHOW_UNAVAILABLE_MEDIA: false },
        capabilityEnable: { embeddings: [], sonicEmbedder: [] },
    },
};

/**
 * The literal value of `key` that means "this capability is ON".
 *
 * Preset merging is enable-wins: if ANY selected preset wants a capability on,
 * it stays on no matter what the others say or what order they were selected
 * in. That rule is only meaningful once you know which literal means "on", and
 * that depends on the key's POLARITY:
 *
 * - Positive polarity (`FEATURE_*`, `*_ENABLED`, …): `true` = on.
 * - Negative polarity (`DISABLE_*`): `false` = on. The key names the *absence*
 *   of the capability, so `true` is the OFF value.
 *
 * The merge originally hardcoded `true` as the winning value for every key.
 * For `DISABLE_*` switches that inverts enable-wins into *disable*-wins: in any
 * multi-preset selection, one preset's `DISABLE_X: true` overrode another's
 * explicit `DISABLE_X: false` and silently turned the task off. Observed on
 * preprod with `INSTANCE_USE_CASES=['vod','music','enterprise']`, where
 * enterprise's `DISABLE_FRIBB_ANIME_SYNC: true` beat vod's explicit `false`;
 * the task then no-op'd on every scheduled run (returning success) while its
 * coverage stage accumulated 9,174 rows stuck `pending` for 51 days.
 *
 * Keep this in sync with the config schema: a new negative-polarity key that
 * is NOT named `DISABLE_*` must be added here explicitly, or it will merge
 * backwards the same way. `negativePolarityKeys` in the test suite guards this.
 */
export function onValue(key: string): boolean {
    return !key.startsWith('DISABLE_');
}

/** Baseline (schema default) for a managed key, coerced to patch value type. */
function baselineFor(key: string): string | boolean | string[] {
    const entry = configSchema.find((s) => s.key === key);
    const d = entry?.defaultValue;
    if (typeof d === 'boolean' || typeof d === 'string' || Array.isArray(d)) return d;
    if (d === undefined || d === null) return false;
    return String(d);
}

export function schemaBaseline(key: string): string | boolean | string[] {
    return baselineFor(key);
}

/** Every key any preset can touch, plus the three orchestration keys. */
export const MANAGED_KEYS: string[] = (() => {
    const set = new Set<string>([
        'INSTANCE_PRIMARY_MODE',
        'FEATURE_MUSIC_FIRST',
        'INSTANCE_LANDING_PATH',
    ]);
    for (const p of Object.values(USE_CASE_PRESETS)) {
        for (const k of p.enable) set.add(k);
        for (const k of p.disable) set.add(k);
        for (const k of Object.keys(p.taskSwitches)) set.add(k);
        for (const k of Object.keys(p.extraConfig)) set.add(k);
        for (const k of p.capabilityEnable.embeddings) set.add(k);
        for (const k of p.capabilityEnable.sonicEmbedder) set.add(k);
    }
    // FEATURE_MUSIC_FIRST is orchestrated, never via extraConfig projection.
    return [...set];
})();

export function applyUseCasePreset(selected: UseCaseId[], caps: PresetCapabilities): ApplyResult {
    const presets = selected
        .filter((id) => Object.hasOwn(USE_CASE_PRESETS, id))
        .map((id) => USE_CASE_PRESETS[id]);

    // Collect, per key, the set of explicit values requested by selected presets.
    const enabledKeys = new Set<string>();
    const requested = new Map<string, string | boolean | string[]>();
    const setVal = (k: string, v: string | boolean | string[]): void => {
        // enable-wins: the value meaning "capability ON" beats a later OFF.
        // Which literal that is depends on the key's POLARITY — see onValue().
        const on = onValue(k);
        if (v === on) enabledKeys.add(k);
        if (!requested.has(k) || v === on) requested.set(k, v);
    };

    for (const p of presets) {
        for (const k of p.enable) setVal(k, true);
        for (const k of p.disable) {
            if (!enabledKeys.has(k)) setVal(k, false);
        }
        for (const [k, v] of Object.entries(p.taskSwitches)) {
            // Polarity-aware: for a `DISABLE_*` switch the ON value is `false`.
            // Comparing against a bare `true` here made every negative-polarity
            // switch resolve backwards — see onValue().
            if (v === onValue(k)) setVal(k, v);
            else if (!enabledKeys.has(k)) setVal(k, v);
        }
        // extraConfig values are projected via setVal: a `true` always wins
        // (enable-wins); other values take the first selected preset's value.
        // Today only boolean SHOW_UNAVAILABLE_MEDIA lives here, where `true`
        // correctly wins in any order. Adding non-boolean extraConfig keys that
        // two presets set differently would be first-wins — revisit setVal then.
        for (const [k, v] of Object.entries(p.extraConfig)) {
            if (k === 'FEATURE_MUSIC_FIRST') continue; // orchestrated below
            setVal(k, v);
        }
        if (caps.hasEmbeddings) for (const k of p.capabilityEnable.embeddings) setVal(k, true);
        if (caps.hasSonicEmbedder)
            for (const k of p.capabilityEnable.sonicEmbedder) setVal(k, true);
    }

    // Resolve primary mode by lowest rank (vod > music > enterprise); empty → vod.
    const primary = presets.reduce<UseCasePreset | null>(
        (best, p) => (best === null || p.primaryRank < best.primaryRank ? p : best),
        null,
    );
    const primaryMode: UseCaseId = primary?.primaryModeCandidate ?? 'vod';
    const landingPath = primary?.landingPath ?? '';

    // Project EVERY managed key: requested value, else baseline.
    const patch: Record<string, string | boolean | string[]> = {};
    for (const k of MANAGED_KEYS) {
        patch[k] = requested.has(k)
            ? (requested.get(k) as string | boolean | string[])
            : baselineFor(k);
    }
    // Orchestration keys override projection.
    patch.INSTANCE_PRIMARY_MODE = primaryMode;
    patch.FEATURE_MUSIC_FIRST = primaryMode === 'music';
    patch.INSTANCE_LANDING_PATH = landingPath;

    const libraryTypes = [...new Set(presets.flatMap((p) => p.libraryTypes))];
    const requestedKeys = [
        ...requested.keys(),
        'INSTANCE_PRIMARY_MODE',
        'FEATURE_MUSIC_FIRST',
        ...(landingPath ? ['INSTANCE_LANDING_PATH'] : []),
    ];
    return { patch, requestedKeys, primaryMode, landingPath, libraryTypes };
}

const NO_CAPABILITIES: PresetCapabilities = { hasEmbeddings: false, hasSonicEmbedder: false };
const ALL_CAPABILITIES: PresetCapabilities = { hasEmbeddings: true, hasSonicEmbedder: true };

/**
 * Keys that must be (re)written whenever their guard key turns ON, even if the
 * profile's value for them did not move: switching the public showcase back on
 * must never inherit a token-free setting from an earlier, separate opt-out.
 */
const WRITE_WITH_WHEN_TURNED_ON: Record<string, string[]> = {
    FEATURE_PUBLIC_SHOWCASE: ['SHOWCASE_REQUIRE_TOKEN'],
};

function sameValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
    return a === b;
}

export interface ReapplyResult extends ApplyResult {
    /**
     * Keys the selection change actually asks to change, with the value to
     * write. A subset of the full projection: keys the old and new selections
     * project identically are left as they are.
     */
    writes: Record<string, string | boolean | string[]>;
    /**
     * Of `writes`: keys whose effective value is neither what the previous
     * profile set nor the new value — a setting changed since the last apply
     * that this apply replaces.
     */
    overrides: string[];
    /**
     * Of `writes`: keys the previous apply did not set at all — a preset that
     * gained a key in a later release. Only known when the previous apply was
     * recorded (`AppliedProfile`).
     */
    added: string[];
}

/** What the last instance-profile apply set, stored as `INSTANCE_PROFILE_APPLIED`. */
export interface AppliedProfile {
    useCases: UseCaseId[];
    /** The value the apply projected for every managed key (not the effective value). */
    values: Record<string, string | boolean | string[]>;
    /** ISO time of the apply; doubles as the revision a stale editor is checked against. */
    at: string;
}

/** The previous profile for a re-apply: its use cases, and what it set when recorded. */
export interface PreviousProfile {
    useCases: UseCaseId[];
    values?: Record<string, string | boolean | string[]>;
}

export function serializeAppliedProfile(profile: AppliedProfile): string {
    return JSON.stringify({ v: 1, ...profile });
}

/** Parse a stored `INSTANCE_PROFILE_APPLIED`; anything malformed reads as "not recorded". */
export function parseAppliedProfile(raw: unknown): AppliedProfile | null {
    if (typeof raw !== 'string' || raw === '') return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1 || typeof o.at !== 'string' || !Array.isArray(o.useCases)) return null;
    if (typeof o.values !== 'object' || o.values === null || Array.isArray(o.values)) return null;
    const useCases = o.useCases.filter(
        (id): id is UseCaseId => typeof id === 'string' && Object.hasOwn(USE_CASE_PRESETS, id),
    );
    const values: Record<string, string | boolean | string[]> = {};
    for (const [k, v] of Object.entries(o.values as Record<string, unknown>)) {
        if (
            typeof v === 'string' ||
            typeof v === 'boolean' ||
            (Array.isArray(v) && v.every((x) => typeof x === 'string'))
        ) {
            values[k] = v as string | boolean | string[];
        }
    }
    return { useCases, values, at: o.at };
}

/**
 * Re-apply a use-case profile on top of the configuration in force.
 *
 * The projection covers EVERY managed key (~60 feature flags and task
 * switches), so writing it whole on every apply reset each of them that the
 * admin had changed elsewhere since — re-saving an unchanged profile silently
 * undid their work. Three-way instead, with the previous apply as the common
 * base: a key is written only where the new projection differs from what the
 * previous apply set; otherwise the effective value stays.
 *
 * The base is exact when the previous apply was recorded (`values`): a key a
 * preset gained in a later release, or a capability-gated music feature that
 * was off because the embedder was not configured yet, then differs from the
 * base and is written. For an apply made before recording existed, the base
 * is recomputed from its use cases; capability-gated keys are then ambiguous
 * (left off for want of the capability, or switched off by the admin) and are
 * written when they differ, always reported in `overrides`.
 *
 * `previous: null` means no profile was ever applied — the first pass writes
 * the whole projection.
 */
export function reapplyUseCasePreset(
    previous: PreviousProfile | null,
    selected: UseCaseId[],
    caps: PresetCapabilities,
    current: (key: string) => unknown,
): ReapplyResult {
    const next = applyUseCasePreset(selected, caps);
    if (previous === null) {
        return { ...next, writes: { ...next.patch }, overrides: [], added: [] };
    }
    const recorded = previous.values;
    const base = recorded ?? applyUseCasePreset(previous.useCases, caps).patch;
    // The selection's projection had every capability been available. A key
    // that differs from it only because a capability is missing NOW (embedder
    // briefly failing, key removed) is not a change the profile asks for:
    // without this, any apply in that window turned the music features off.
    const nextWithAllCaps = applyUseCasePreset(selected, ALL_CAPABILITIES).patch;
    // Legacy (unrecorded) only: the same profile without capabilities.
    const baseWithoutCaps = recorded
        ? base
        : applyUseCasePreset(previous.useCases, NO_CAPABILITIES).patch;
    const writes: Record<string, string | boolean | string[]> = {};
    const overrides: string[] = [];
    const added: string[] = [];
    for (const [key, to] of Object.entries(next.patch)) {
        const now = current(key);
        const inBase = key in base;
        const capabilityMissing =
            !sameValue(to, nextWithAllCaps[key]) && sameValue(base[key], nextWithAllCaps[key]);
        const moved = !inBase || (!sameValue(to, base[key]) && !capabilityMissing);
        // Legacy (unrecorded) base only; a recorded base already tells a
        // capability that arrived since apart from the admin's own change.
        const capabilityCatchUp =
            !recorded && !sameValue(to, baseWithoutCaps[key]) && !sameValue(now, to);
        if (!moved && !capabilityCatchUp) continue;
        writes[key] = to;
        if (!inBase) {
            if (!sameValue(now, to)) added.push(key);
        } else if (!sameValue(now, base[key]) && !sameValue(now, to)) {
            overrides.push(key);
        }
    }
    for (const [guard, keys] of Object.entries(WRITE_WITH_WHEN_TURNED_ON)) {
        if (writes[guard] !== true || current(guard) === true) continue;
        for (const key of keys) {
            if (key in writes) continue;
            writes[key] = next.patch[key];
            if (!sameValue(current(key), next.patch[key])) overrides.push(key);
        }
    }
    return { ...next, writes, overrides, added };
}

/**
 * Settings whose value would change if the saved profile were applied again
 * today: a release changed what its presets set, or a capability (embedder)
 * became available. Empty unless the previous apply was recorded. A setting
 * the admin changed is listed only where the profile itself now asks for a
 * different value than it did. The landing page is left out: it follows the
 * profile only when the admin applies.
 */
export function pendingProfileUpdates(
    applied: AppliedProfile | null,
    caps: PresetCapabilities,
    current: (key: string) => unknown,
): string[] {
    if (!applied || applied.useCases.length === 0) return [];
    const r = reapplyUseCasePreset(applied, applied.useCases, caps, current);
    return Object.entries(r.writes)
        .filter(([key, to]) => key !== 'INSTANCE_LANDING_PATH' && !sameValue(current(key), to))
        .map(([key]) => key);
}

/**
 * Keys that the setup wizard writes TWICE: once from a visible toggle on its
 * preferences step (`POST /api/setup/preferences`) and once from the use-case
 * projection (`POST /api/admin/instance-profile`), which on a first pass writes EVERY managed
 * key — the requested value for keys a selected preset asks for, the schema
 * baseline for the rest. Both writes go through the same `saveConfig()` write
 * lock, so nothing is lost, but whichever request takes the lock LAST wins:
 * without ordering, a VOD install's `SHOW_UNAVAILABLE_MEDIA` came out `true`
 * (preset) or `false` (untouched toggle) depending on request timing, and the
 * step-4 recap could disagree with what was actually saved.
 *
 * Resolution (see `persistStep3` in `src/routes/setup/+page.svelte`): the
 * projection is awaited FIRST and the preferences write goes last, so the
 * toggle the operator actually saw is authoritative — and the toggles are
 * seeded from `presetPreferenceDefaults()` so that what they saw already IS
 * the preset's value.
 *
 * Adding a key to `/api/setup/preferences` that any preset also touches means
 * adding it here and seeding its toggle the same way.
 */
export const WIZARD_PREFERENCE_OVERLAP_KEYS = [
    'FEATURE_AUTO_LYRICS',
    'FEATURE_GRAVATAR',
    'PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED',
    'SHOW_UNAVAILABLE_MEDIA',
] as const;

export type WizardPreferenceOverlapKey = (typeof WIZARD_PREFERENCE_OVERLAP_KEYS)[number];

/**
 * The value the use-case projection would write for each overlapping key, used
 * to seed the wizard's toggles so they show the preset's intent rather than a
 * hardcoded default that silently loses (or wins) a race against it.
 *
 * Capabilities are deliberately neutral: they only ever gate `capabilityEnable`
 * keys (embedding/sonic music features), none of which overlap with the
 * preferences endpoint, so the projected value of every key returned here is
 * capability-independent.
 */
export function presetPreferenceDefaults(
    selected: UseCaseId[],
): Record<WizardPreferenceOverlapKey, boolean> {
    const { patch } = applyUseCasePreset(selected, {
        hasEmbeddings: false,
        hasSonicEmbedder: false,
    });
    const out = {} as Record<WizardPreferenceOverlapKey, boolean>;
    for (const k of WIZARD_PREFERENCE_OVERLAP_KEYS) out[k] = patch[k] === true;
    return out;
}
