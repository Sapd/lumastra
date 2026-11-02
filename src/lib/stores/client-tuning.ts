// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-side tuning values sourced from server config.
 *
 * ## Why this module exists
 *
 * Some schema-registered knobs describe behaviour that only the browser can
 * enact — poll cadences, a toast timeout, the player's skip step and its
 * adaptive-bitrate timing — so the value has to cross the server/client
 * boundary before it can have any effect. Before 2026-09-22 the
 * root layout serialized a `watchTogether` / `toast` / `image` block into
 * `__data.json` for exactly this purpose, but nothing ever read them:
 * `WatchParties.svelte` hardcoded its own 15000, the toast store hardcoded
 * 5000, and `getImageConfig()` was never called. `735f823f9` removed the
 * blocks as unrenderable bytes. That was correct — but it left the schema
 * entries behind, so the admin UI still rendered live-looking controls for
 * knobs that had never done anything.
 *
 * This module is the reader those bytes were always missing. The rule it
 * exists to enforce:
 *
 *   **A value only belongs in the layout payload once something here reads
 *   it.** `__data.json` is `private, no-store`, so every key is re-serialized
 *   on every client-side navigation, on every route, forever. A few numbers
 *   are a fair price for knobs that work; one number for a knob nothing reads
 *   is pure waste. `layout.server.payload-shape.test.ts` is the ratchet.
 *
 * ## Why a module and not `$page.data`
 *
 * `episodes.progressBarThreshold` is read straight off `$page.data` by the one
 * component that wants it, which is fine for a component. Most of these
 * consumers are plain `.ts` modules (`toast.store.svelte.ts`,
 * `watchTogether.svelte.ts`) with no page-data access, so they need a plain
 * import. Routing them all through one module keeps a single hydration seam
 * and one place where the defaults live.
 *
 * ## Safety property
 *
 * Every default here is the literal the call site used before it was wired.
 * Until `hydrateClientTuning` runs — SSR, an unhydrated first paint, a unit
 * test that imports a consumer directly — every accessor returns exactly
 * today's behaviour. Wiring can therefore only ever change behaviour for an
 * operator who actually set the knob.
 *
 * Deliberately dependency-free (no `$app/*`, no Svelte runtime) so server
 * modules and node-environment tests can import a consumer without pulling in
 * the SvelteKit client runtime.
 */

export interface ClientTuning {
    /** `WATCH_PARTIES_REFRESH_MS` — active-parties list refetch cadence. */
    partiesRefreshMs: number;
    /** `WATCH_TOGETHER_MAX_RECONNECT_MS` — ceiling on SSE reconnect backoff. */
    watchTogetherMaxReconnectMs: number;
    /** `PLAYLIST_CHAT_POLL_MS` — lightweight new-message poll cadence. */
    playlistChatPollMs: number;
    /** `TOAST_DEFAULT_TIMEOUT_MS` — auto-dismiss delay when none is passed. */
    toastDefaultTimeoutMs: number;
    /** `PLAYER_SKIP_SECONDS` — skip/seek step when the user has not set their own. */
    playerSkipSeconds: number;
    /** `PLAYER_QUALITY_STABILITY_MS` — ABR: no switch this long after playback starts. */
    abrStabilityMs: number;
    /** `PLAYER_QUALITY_DOWN_COOLDOWN_MS` — ABR: wait after switching down. */
    abrDownCooldownMs: number;
    /** `PLAYER_QUALITY_UP_COOLDOWN_MS` — ABR: wait after switching up. */
    abrUpCooldownMs: number;
    /** `PLAYER_BANDWIDTH_SAMPLES` — ABR: bandwidth samples averaged. */
    abrBandwidthSamples: number;
    /** `PLAYER_MIN_SAMPLES_BEFORE_SWITCH` — ABR: samples needed before the first switch. */
    abrMinSamplesBeforeSwitch: number;
    /** `PLAYER_MIN_ADAPTIVE_BITRATE` — ABR: lowest bitrate it switches down to (bps). */
    abrMinAdaptiveBitrate: number;
    /** `REQUEST_AVAILABLE_EXPIRE_HOURS` — how long an "available" request card stays. */
    requestAvailableExpireHours: number;
}

/**
 * The literals each consumer used before it read this module. These must stay
 * equal to the corresponding `defaultValue` in `src/lib/config/schema.ts` and
 * the fallback in `src/lib/server/config.ts`; `client-tuning.test.ts` pins that
 * three-way agreement so a default can't drift on one side only.
 */
export const CLIENT_TUNING_DEFAULTS: Readonly<ClientTuning> = Object.freeze({
    partiesRefreshMs: 15000,
    watchTogetherMaxReconnectMs: 30000,
    playlistChatPollMs: 15000,
    toastDefaultTimeoutMs: 5000,
    // SEEK.DEFAULT_SECONDS and the player-utils.ts ABR constants.
    playerSkipSeconds: 10,
    abrStabilityMs: 10000,
    abrDownCooldownMs: 10000,
    abrUpCooldownMs: 30000,
    abrBandwidthSamples: 5,
    abrMinSamplesBeforeSwitch: 3,
    abrMinAdaptiveBitrate: 2000000,
    requestAvailableExpireHours: 24,
});

let current: ClientTuning = { ...CLIENT_TUNING_DEFAULTS };

/**
 * Merge server-provided tuning over the defaults.
 *
 * Called reactively from the root layout with `data.clientTuning`. Each field
 * is taken only when it is a finite positive number, so a malformed or partial
 * payload degrades to the default for that field rather than poisoning a timer
 * with `NaN` (a `setInterval(fn, NaN)` fires as fast as the browser allows).
 */
export function hydrateClientTuning(data: Partial<ClientTuning> | null | undefined): void {
    if (!data) return;
    const merged = { ...CLIENT_TUNING_DEFAULTS };
    for (const key of Object.keys(CLIENT_TUNING_DEFAULTS) as (keyof ClientTuning)[]) {
        const value = data[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            merged[key] = value;
        }
    }
    current = merged;
}

/** Test seam: drop back to the shipped defaults. */
export function resetClientTuning(): void {
    current = { ...CLIENT_TUNING_DEFAULTS };
}

/** The whole resolved set (used by tests; prefer a named accessor in app code). */
export function clientTuning(): Readonly<ClientTuning> {
    return current;
}

export const partiesRefreshMs = (): number => current.partiesRefreshMs;
export const watchTogetherMaxReconnectMs = (): number => current.watchTogetherMaxReconnectMs;
export const playlistChatPollMs = (): number => current.playlistChatPollMs;
export const toastDefaultTimeoutMs = (): number => current.toastDefaultTimeoutMs;
export const playerSkipSeconds = (): number => current.playerSkipSeconds;
export const requestAvailableExpireHours = (): number => current.requestAvailableExpireHours;

/** ABR timing in the shape `adaptive-bitrate.ts` takes as `config.timing`. */
export interface AbrTiming {
    stabilityPeriodMs: number;
    downCooldownMs: number;
    upCooldownMs: number;
    bandwidthSamples: number;
    minSamplesBeforeSwitch: number;
    minAdaptiveBitrate: number;
}

export const abrTiming = (): AbrTiming => ({
    stabilityPeriodMs: current.abrStabilityMs,
    downCooldownMs: current.abrDownCooldownMs,
    upCooldownMs: current.abrUpCooldownMs,
    bandwidthSamples: current.abrBandwidthSamples,
    minSamplesBeforeSwitch: current.abrMinSamplesBeforeSwitch,
    minAdaptiveBitrate: current.abrMinAdaptiveBitrate,
});
