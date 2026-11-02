// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback Preferences Sync Service
 *
 * Syncs playback preferences between server and localStorage with
 * dirty-key tracking:
 * - Every user edit marks its key "dirty" with a monotonic revision.
 * - Debounced flush sends ONLY dirty keys; on success, a key is cleared
 *   only if its revision still matches (so same-key edits during an
 *   in-flight request survive).
 * - Reads from server (initial load, cross-tab `storage` event) skip
 *   dirty keys so in-flight user edits are never clobbered.
 * - Values and revisions live in immutable tab-owned replay journals scoped
 *   to a shared account-cleanup epoch. A surviving tab can replay discarded
 *   edits without an unrelated acknowledgement erasing them.
 */

import * as userApi from '$lib/api/user';
import { withPreferenceWriteLock } from '$lib/shared/preference-write-coordinator';
import {
    PlaybackPreferenceJournal,
    PREFERENCE_EPOCH_KEY,
    PREFERENCE_PERMIT_KEY,
    type PreferenceJournalEdit,
} from '$lib/shared/playback-preference-journal';
import type { PlaybackPreferencesInput, SubtitleTrackHint } from '$lib/schemas/user.js';
export type { SubtitleTrackHint } from '$lib/schemas/user.js';
import { SUBTITLE_FONT_SIZE_MAX, SUBTITLE_FONT_SIZE_MIN } from '$lib/schemas/user.js';

export type SubtitleStylePreset = 'default' | 'outlined' | 'background' | 'shadow' | 'none';

export interface SubtitleStyleSettings {
    preset: SubtitleStylePreset;
    fontSize: number; // 0.5 - 2.5, default 1.0
    fontFamily: 'system' | 'serif' | 'mono';
    textColor: string; // hex color
    backgroundColor: string; // hex color with alpha
    outlineColor: string; // hex color
    outlineWidth: number; // 0-4px
    shadowBlur: number; // 0-8px
    positionY: number; // 0-100 percentage from top (default: 85 for desktop)
}

export interface PlaybackPreferences {
    audioLanguage: string | null;
    lastAudioLanguage: string | null;
    /** Tier-0: prefer the title's own production language over `audioLanguage`. */
    preferOriginalAudio: boolean;
    subtitleLanguage: string | null;
    subtitlesEnabled: boolean;
    forcedSubtitlesEnabled: boolean;
    qualityMode: 'original' | 'auto' | 'fixed';
    maxBitrateBps: number | null;
    preferredResolution: string | null;
    autoplayNextEpisode: boolean;
    skipIntroAutomatically: boolean;
    skipCreditsAutomatically: boolean;
    subtitleStyle: SubtitleStyleSettings;
    subtitleTrackHint: SubtitleTrackHint | null;
    showEpisodeLanguages: boolean;
    showAnnotationMarkers: boolean;
    autoShowAnnotations: boolean;
    volume: number;
    isMuted: boolean;
    nextEpisodeCountdownSeconds: number | null;
    nextEpisodeCountdownSecondsDefault: number;
    showNextEpisodePopup: boolean;
    nextEpisodePromptLeadSeconds: number | null;
    noOutroFallbackSeconds: number | null;
    seekStepSeconds: number | null;
    autoDismissNextEpisodePopup: boolean;
    /** Ask "are you still watching?" after two unattended auto-played episodes. */
    stillWatchingEnabled: boolean;
    updatedAt?: string;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleSettings = {
    preset: 'default',
    fontSize: 1.0,
    fontFamily: 'system',
    textColor: '#FFFFFF',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    outlineColor: '#000000',
    outlineWidth: 0,
    shadowBlur: 4,
    positionY: 85,
};

export const SUBTITLE_STYLE_PRESETS: Record<SubtitleStylePreset, Partial<SubtitleStyleSettings>> = {
    default: {
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        outlineWidth: 0,
        shadowBlur: 4,
    },
    outlined: {
        backgroundColor: 'transparent',
        outlineWidth: 3,
        shadowBlur: 2,
    },
    background: {
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
        outlineWidth: 0,
        shadowBlur: 0,
    },
    shadow: {
        backgroundColor: 'transparent',
        outlineWidth: 0,
        shadowBlur: 8,
    },
    none: {
        backgroundColor: 'transparent',
        outlineWidth: 0,
        shadowBlur: 0,
    },
};

const DEFAULT_PREFERENCES: PlaybackPreferences = {
    audioLanguage: null,
    lastAudioLanguage: null,
    preferOriginalAudio: false,
    subtitleLanguage: null,
    subtitlesEnabled: true,
    forcedSubtitlesEnabled: true,
    qualityMode: 'original',
    maxBitrateBps: null,
    preferredResolution: null,
    autoplayNextEpisode: true,
    skipIntroAutomatically: false,
    skipCreditsAutomatically: false,
    subtitleStyle: DEFAULT_SUBTITLE_STYLE,
    subtitleTrackHint: null,
    showEpisodeLanguages: true,
    showAnnotationMarkers: true,
    autoShowAnnotations: true,
    volume: 1,
    isMuted: false,
    nextEpisodeCountdownSeconds: null,
    nextEpisodeCountdownSecondsDefault: 10,
    showNextEpisodePopup: true,
    nextEpisodePromptLeadSeconds: null,
    noOutroFallbackSeconds: null,
    seekStepSeconds: null,
    autoDismissNextEpisodePopup: false,
    stillWatchingEnabled: false,
};

const LOCAL_STORAGE_KEY = 'playerPreferences';
const DEBOUNCE_MS = 2000; // 2 seconds debounce for server updates

/** Fields stored only in localStorage, not persisted to server */
const LOCAL_ONLY_FIELDS = new Set<keyof PlaybackPreferences>([
    'volume',
    'isMuted',
    'updatedAt',
    'nextEpisodeCountdownSecondsDefault',
]);

// Char-indexed corruption (string accidentally serialized as char-keyed object)
// has no named `fontSize`; that's the fast-path to full defaults. Everything
// else flows through per-field sanitization so a stored style from an older
// app version (missing newer fields) or with out-of-range values keeps the
// user's valid customizations and patches the rest from DEFAULT_SUBTITLE_STYLE.
function isCorruptedSubtitleStyle(style: unknown): boolean {
    if (!style || typeof style !== 'object') return true;
    return !('fontSize' in (style as Record<string, unknown>));
}

const VALID_PRESETS = new Set<SubtitleStylePreset>([
    'default',
    'outlined',
    'background',
    'shadow',
    'none',
]);
const VALID_FONT_FAMILIES = new Set<'system' | 'serif' | 'mono'>(['system', 'serif', 'mono']);

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

function normalizeSubtitleStyle(style: unknown): SubtitleStyleSettings {
    if (isCorruptedSubtitleStyle(style)) {
        return { ...DEFAULT_SUBTITLE_STYLE };
    }
    const s = style as Partial<SubtitleStyleSettings>;
    // Bounds come from the schema so the sanitizer can never emit a value the
    // server rejects — a rejected flush leaves the key dirty and replays forever.
    const fontSize = clampFinite(
        s.fontSize,
        SUBTITLE_FONT_SIZE_MIN,
        SUBTITLE_FONT_SIZE_MAX,
        DEFAULT_SUBTITLE_STYLE.fontSize,
    );
    return {
        preset:
            typeof s.preset === 'string' && VALID_PRESETS.has(s.preset)
                ? s.preset
                : DEFAULT_SUBTITLE_STYLE.preset,
        // 0 or negative fontSize makes subtitles invisible — fall back to default
        fontSize: fontSize > 0 ? fontSize : DEFAULT_SUBTITLE_STYLE.fontSize,
        fontFamily:
            typeof s.fontFamily === 'string' && VALID_FONT_FAMILIES.has(s.fontFamily)
                ? s.fontFamily
                : DEFAULT_SUBTITLE_STYLE.fontFamily,
        textColor: typeof s.textColor === 'string' ? s.textColor : DEFAULT_SUBTITLE_STYLE.textColor,
        backgroundColor:
            typeof s.backgroundColor === 'string'
                ? s.backgroundColor
                : DEFAULT_SUBTITLE_STYLE.backgroundColor,
        outlineColor:
            typeof s.outlineColor === 'string'
                ? s.outlineColor
                : DEFAULT_SUBTITLE_STYLE.outlineColor,
        outlineWidth: clampFinite(s.outlineWidth, 0, 10, DEFAULT_SUBTITLE_STYLE.outlineWidth),
        shadowBlur: clampFinite(s.shadowBlur, 0, 20, DEFAULT_SUBTITLE_STYLE.shadowBlur),
        positionY: clampFinite(s.positionY, 0, 100, DEFAULT_SUBTITLE_STYLE.positionY),
    };
}

function isValidSubtitleTrackHint(hint: unknown): hint is SubtitleTrackHint {
    if (!hint || typeof hint !== 'object') return false;
    const h = hint as Record<string, unknown>;
    return (
        typeof h.language === 'string' &&
        typeof h.isForced === 'boolean' &&
        (h.codec === null || typeof h.codec === 'string') &&
        ['title', 'fileId', 'trackId'].every(
            (key) => h[key] === undefined || typeof h[key] === 'string',
        )
    );
}

// Check if we're in a browser environment
const isBrowser = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
const preferenceJournal = isBrowser
    ? new PlaybackPreferenceJournal(
          window.localStorage,
          (field) =>
              Object.hasOwn(DEFAULT_PREFERENCES, field) &&
              !LOCAL_ONLY_FIELDS.has(field as keyof PlaybackPreferences),
      )
    : null;

function parseJson(raw: string): unknown | null {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        /* expected: malformed JSON in localStorage preferences cache */
        return null;
    }
}

function normalizePreferences(raw: unknown): PlaybackPreferences | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const merged = {
        ...DEFAULT_PREFERENCES,
        ...(raw as Partial<PlaybackPreferences>),
    };

    if (typeof merged.showEpisodeLanguages !== 'boolean') {
        merged.showEpisodeLanguages = DEFAULT_PREFERENCES.showEpisodeLanguages;
    }

    if (typeof merged.subtitleStyle === 'string') {
        merged.subtitleStyle = normalizeSubtitleStyle(parseJson(merged.subtitleStyle));
    } else {
        merged.subtitleStyle = normalizeSubtitleStyle(merged.subtitleStyle);
    }

    // Validate subtitleTrackHint — tolerate legacy rows that have the key missing
    // or stored as a JSON string.
    if (typeof merged.subtitleTrackHint === 'string') {
        const parsedHint = parseJson(merged.subtitleTrackHint);
        merged.subtitleTrackHint = isValidSubtitleTrackHint(parsedHint) ? parsedHint : null;
    } else if (
        merged.subtitleTrackHint !== null &&
        !isValidSubtitleTrackHint(merged.subtitleTrackHint)
    ) {
        merged.subtitleTrackHint = null;
    }

    return merged;
}

function getInitialPreferences(): PlaybackPreferences {
    if (!isBrowser) {
        return DEFAULT_PREFERENCES;
    }

    try {
        const saved = preferenceJournal?.readCache(LOCAL_STORAGE_KEY);
        if (saved) {
            const normalized = normalizePreferences(saved);
            if (normalized) {
                return normalized;
            }
        }
    } catch (e) {
        console.warn('[PreferencesSync] Failed to load from localStorage:', e);
    }

    return DEFAULT_PREFERENCES;
}

function saveToLocalStorage(preferences: PlaybackPreferences): void {
    if (!isBrowser || !currentPreferenceContext()) return;

    try {
        preferenceJournal?.writeCache(
            LOCAL_STORAGE_KEY,
            preferences as unknown as Record<string, unknown>,
        );
    } catch (e) {
        console.warn('[PreferencesSync] Failed to save to localStorage:', e);
    }
}

async function loadFromServer(): Promise<
    { ok: true; preferences: PlaybackPreferences | null } | { ok: false }
> {
    try {
        const { data, error } = await userApi.getPlaybackPreferences();
        if (error) {
            console.warn('[PreferencesSync] Server returned error:', error);
            return { ok: false };
        }

        // A successful absent row is distinct from a failed read.
        return { ok: true, preferences: normalizePreferences(data) };
    } catch (e) {
        console.warn('[PreferencesSync] Failed to load from server:', e);
    }

    return { ok: false };
}

async function saveToServer(
    payload: Partial<PlaybackPreferencesInput>,
    signal?: AbortSignal,
): Promise<boolean> {
    if (Object.keys(payload).length === 0) {
        return true;
    }
    try {
        const { error, code, details } = await userApi.updatePlaybackPreferences(payload, {
            keepalive: true,
            ...(signal ? { signal } : {}),
        });
        if (error) {
            // Log the field-level detail, not just "Request validation failed".
            // A 422 here names the offending field in `details` ([{field, message}]),
            // and without it the only way to find out which of ~25 optional fields the
            // server rejected is to open the Network tab and read the response by hand.
            console.warn('[PreferencesSync] Server update failed:', error, {
                code,
                details,
                sentKeys: Object.keys(payload),
            });
            return false;
        }
        return true;
    } catch (e) {
        console.warn('[PreferencesSync] Failed to save to server:', e);
        return false;
    }
}

function hasCustomPreferences(prefs: PlaybackPreferences): boolean {
    return (
        prefs.audioLanguage !== null ||
        prefs.preferOriginalAudio ||
        prefs.subtitleLanguage !== null ||
        prefs.subtitleTrackHint !== null ||
        prefs.subtitlesEnabled !== DEFAULT_PREFERENCES.subtitlesEnabled ||
        prefs.forcedSubtitlesEnabled !== DEFAULT_PREFERENCES.forcedSubtitlesEnabled ||
        prefs.showEpisodeLanguages !== DEFAULT_PREFERENCES.showEpisodeLanguages ||
        prefs.qualityMode !== 'original' ||
        prefs.maxBitrateBps !== null
    );
}

// =============================================================================
// Dirty-key tracking (module-level)
// =============================================================================

/**
 * Keys the user has modified locally since the last successful server flush.
 * Value is a monotonic per-key revision — incremented on every write, compared
 * on flush success to avoid clobbering edits that landed during an in-flight
 * request.
 */
// Intentionally a plain Map — this is non-reactive sync-bookkeeping state,
// not UI state. SvelteMap would introduce $state tracking that nothing
// subscribes to.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const dirtyKeys = new Map<keyof PlaybackPreferences, number>();
let revisionCounter = 0;
const selectionRevisions = { audio: 0, subtitle: 0 };
const AUDIO_PREFERENCE_KEYS = [
    'audioLanguage',
    'lastAudioLanguage',
    'preferOriginalAudio',
] as const;
const SUBTITLE_PREFERENCE_KEYS = [
    'subtitleLanguage',
    'subtitlesEnabled',
    'forcedSubtitlesEnabled',
    'subtitleTrackHint',
] as const;
export interface SelectionPreferenceSnapshot {
    audio: number;
    subtitle: number;
    audioDirty: boolean;
    subtitleDirty: boolean;
}
export function selectionPreferenceSnapshot(): SelectionPreferenceSnapshot {
    return {
        ...selectionRevisions,
        audioDirty: AUDIO_PREFERENCE_KEYS.some((key) => dirtyKeys.has(key)),
        subtitleDirty: SUBTITLE_PREFERENCE_KEYS.some((key) => dirtyKeys.has(key)),
    };
}
export function staleSelectionPreferences(snapshot?: SelectionPreferenceSnapshot): {
    audio: boolean;
    subtitle: boolean;
} {
    const current = selectionPreferenceSnapshot();
    return {
        audio:
            current.audioDirty ||
            !!snapshot?.audioDirty ||
            (snapshot !== undefined && current.audio !== snapshot.audio),
        subtitle:
            current.subtitleDirty ||
            !!snapshot?.subtitleDirty ||
            (snapshot !== undefined && current.subtitle !== snapshot.subtitle),
    };
}
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let serverLoaded = false;
let preferenceEpoch = 0;
let preferenceWriteAbort = new AbortController();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- unsent storage bookkeeping.
const unpersistedDirty = new Set<keyof PlaybackPreferences>();
let preferenceActive = !preferenceJournal?.cleared;
// Durable edits represented by this tab, including entries adopted on reload.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const pendingJournalEntries = new Map<keyof PlaybackPreferences, PreferenceJournalEdit[]>();
function currentPreferenceContext(): boolean {
    if (preferenceJournal && !preferenceJournal.isCurrent())
        playbackPreferences._invalidateAccount();
    return preferenceActive;
}
// Concurrent-call guard for initialize(). Rapid SvelteKit remounts can call
// initializePreferences() twice before the first fetch resolves; without this
// the second call enters the fetch path too, racing the first.
let initializePromise: Promise<void> | null = null;

class PlaybackPreferencesStore {
    // Preference fields as $state
    audioLanguage: string | null = $state(DEFAULT_PREFERENCES.audioLanguage);
    lastAudioLanguage: string | null = $state(DEFAULT_PREFERENCES.lastAudioLanguage);
    preferOriginalAudio: boolean = $state(DEFAULT_PREFERENCES.preferOriginalAudio);
    subtitleLanguage: string | null = $state(DEFAULT_PREFERENCES.subtitleLanguage);
    subtitlesEnabled: boolean = $state(DEFAULT_PREFERENCES.subtitlesEnabled);
    forcedSubtitlesEnabled: boolean = $state(DEFAULT_PREFERENCES.forcedSubtitlesEnabled);
    qualityMode: 'original' | 'auto' | 'fixed' = $state(DEFAULT_PREFERENCES.qualityMode);
    maxBitrateBps: number | null = $state(DEFAULT_PREFERENCES.maxBitrateBps);
    preferredResolution: string | null = $state(DEFAULT_PREFERENCES.preferredResolution);
    autoplayNextEpisode: boolean = $state(DEFAULT_PREFERENCES.autoplayNextEpisode);
    skipIntroAutomatically: boolean = $state(DEFAULT_PREFERENCES.skipIntroAutomatically);
    skipCreditsAutomatically: boolean = $state(DEFAULT_PREFERENCES.skipCreditsAutomatically);
    subtitleStyle: SubtitleStyleSettings = $state(DEFAULT_PREFERENCES.subtitleStyle);
    subtitleTrackHint: SubtitleTrackHint | null = $state(DEFAULT_PREFERENCES.subtitleTrackHint);
    showEpisodeLanguages: boolean = $state(DEFAULT_PREFERENCES.showEpisodeLanguages);
    showAnnotationMarkers: boolean = $state(DEFAULT_PREFERENCES.showAnnotationMarkers);
    autoShowAnnotations: boolean = $state(DEFAULT_PREFERENCES.autoShowAnnotations);
    volume: number = $state(DEFAULT_PREFERENCES.volume);
    isMuted: boolean = $state(DEFAULT_PREFERENCES.isMuted);
    nextEpisodeCountdownSeconds: number | null = $state(
        DEFAULT_PREFERENCES.nextEpisodeCountdownSeconds,
    );
    nextEpisodeCountdownSecondsDefault: number = $state(
        DEFAULT_PREFERENCES.nextEpisodeCountdownSecondsDefault,
    );
    showNextEpisodePopup: boolean = $state(DEFAULT_PREFERENCES.showNextEpisodePopup);
    nextEpisodePromptLeadSeconds: number | null = $state(
        DEFAULT_PREFERENCES.nextEpisodePromptLeadSeconds,
    );
    noOutroFallbackSeconds: number | null = $state(DEFAULT_PREFERENCES.noOutroFallbackSeconds);
    seekStepSeconds: number | null = $state(DEFAULT_PREFERENCES.seekStepSeconds);
    autoDismissNextEpisodePopup: boolean = $state(DEFAULT_PREFERENCES.autoDismissNextEpisodePopup);
    stillWatchingEnabled: boolean = $state(DEFAULT_PREFERENCES.stillWatchingEnabled);
    updatedAt = $state<string | undefined>(undefined);

    loading: boolean = $state(false);
    ready = $state(false);
    storageUnavailable = $state(false);

    /**
     * Last known-good (non-audio-only) qualityMode. Audio-only is a
     * SESSION-only mode that must never be persisted or synced (quality
     * prefs are per-user and shared across every device). #snapshot() falls
     * back to this instead of a hardcoded 'original' so a user with a real
     * stored 'fixed' rung doesn't get clobbered by an audio-only session.
     */
    #lastPersistedQualityMode: PlaybackPreferences['qualityMode'] = DEFAULT_PREFERENCES.qualityMode;

    constructor() {
        const initial = getInitialPreferences();
        this.#applyPreferences(initial);
        if (preferenceActive) {
            if (preferenceJournal && !preferenceJournal.migrateLegacy(LOCAL_STORAGE_KEY))
                this.#storageFailure();
            this.#adoptReplay();
        }
    }

    #adoptReplay(): void {
        const all = preferenceJournal?.entries() ?? [];
        // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replay bookkeeping, never reactive state.
        const groups = new Map<keyof PlaybackPreferences, PreferenceJournalEdit[]>();
        for (const edit of all) {
            const key = edit.field as keyof PlaybackPreferences;
            const entries = groups.get(key) ?? [];
            entries.push(edit);
            groups.set(key, entries);
            revisionCounter = Math.max(revisionCounter, edit.revision);
        }
        const snapshot = this.#snapshot() as unknown as Record<string, unknown>;
        for (const [key, entries] of groups) {
            const own = entries.filter((edit) => edit.owner === preferenceJournal?.owner).at(-1);
            const ownTimestamp = dirtyKeys.has(key) ? own?.updatedAt : undefined;
            const represented =
                ownTimestamp !== undefined
                    ? entries.filter(
                          (edit) =>
                              edit.updatedAt <= ownTimestamp ||
                              JSON.stringify(edit.value) === JSON.stringify(snapshot[key]),
                      )
                    : entries;
            const winner = ownTimestamp !== undefined ? undefined : represented.at(-1);
            if (winner) {
                const normalized = normalizePreferences({ [key]: winner.value });
                if (normalized) {
                    (this as unknown as Record<string, unknown>)[key] = normalized[key];
                    if (key === 'qualityMode')
                        this.#lastPersistedQualityMode = normalized.qualityMode;
                }
            }
            pendingJournalEntries.set(key, represented);
            const revision = ++revisionCounter;
            dirtyKeys.set(key, revision);
            if (AUDIO_PREFERENCE_KEYS.some((field) => field === key))
                selectionRevisions.audio = revision;
            if (SUBTITLE_PREFERENCE_KEYS.some((field) => field === key))
                selectionRevisions.subtitle = revision;
        }
    }

    #applyPreferences(prefs: PlaybackPreferences): void {
        this.audioLanguage = prefs.audioLanguage;
        this.lastAudioLanguage = prefs.lastAudioLanguage;
        this.preferOriginalAudio = prefs.preferOriginalAudio ?? false;
        this.subtitleLanguage = prefs.subtitleLanguage;
        this.subtitlesEnabled = prefs.subtitlesEnabled;
        this.forcedSubtitlesEnabled = prefs.forcedSubtitlesEnabled;
        this.qualityMode = prefs.qualityMode;
        this.#lastPersistedQualityMode = prefs.qualityMode;
        this.maxBitrateBps = prefs.maxBitrateBps;
        this.preferredResolution = prefs.preferredResolution;
        this.autoplayNextEpisode = prefs.autoplayNextEpisode;
        this.skipIntroAutomatically = prefs.skipIntroAutomatically;
        this.skipCreditsAutomatically = prefs.skipCreditsAutomatically;
        this.subtitleStyle = prefs.subtitleStyle;
        this.subtitleTrackHint = prefs.subtitleTrackHint;
        this.showEpisodeLanguages = prefs.showEpisodeLanguages;
        this.showAnnotationMarkers = prefs.showAnnotationMarkers;
        this.autoShowAnnotations = prefs.autoShowAnnotations;
        this.volume = prefs.volume ?? 1;
        this.isMuted = prefs.isMuted ?? false;
        this.nextEpisodeCountdownSeconds = prefs.nextEpisodeCountdownSeconds ?? null;
        this.nextEpisodeCountdownSecondsDefault = prefs.nextEpisodeCountdownSecondsDefault ?? 10;
        this.showNextEpisodePopup = prefs.showNextEpisodePopup ?? true;
        this.nextEpisodePromptLeadSeconds = prefs.nextEpisodePromptLeadSeconds ?? null;
        this.noOutroFallbackSeconds = prefs.noOutroFallbackSeconds ?? null;
        this.seekStepSeconds = prefs.seekStepSeconds ?? null;
        this.autoDismissNextEpisodePopup = prefs.autoDismissNextEpisodePopup ?? false;
        this.stillWatchingEnabled = prefs.stillWatchingEnabled ?? false;
        this.updatedAt = prefs.updatedAt;
    }

    #snapshot(): PlaybackPreferences {
        return {
            audioLanguage: this.audioLanguage,
            lastAudioLanguage: this.lastAudioLanguage,
            preferOriginalAudio: this.preferOriginalAudio,
            subtitleLanguage: this.subtitleLanguage,
            subtitlesEnabled: this.subtitlesEnabled,
            forcedSubtitlesEnabled: this.forcedSubtitlesEnabled,
            // Audio-only must never leave this class — it's a SESSION mode,
            // not a stored preference (see #lastPersistedQualityMode above).
            // This is defence in depth: the primary guard is in
            // playerStore.setQualityProfile, which never calls
            // updatePreferences() for an audio-only selection in the first
            // place. Fall back to the last persisted mode, NOT a hardcoded
            // 'original' — that would clobber a user's real stored 'fixed'
            // rung on every other device they own.
            qualityMode:
                (this.qualityMode as string) === 'audio-only'
                    ? this.#lastPersistedQualityMode
                    : this.qualityMode,
            maxBitrateBps: this.maxBitrateBps,
            preferredResolution: this.preferredResolution,
            autoplayNextEpisode: this.autoplayNextEpisode,
            skipIntroAutomatically: this.skipIntroAutomatically,
            skipCreditsAutomatically: this.skipCreditsAutomatically,
            subtitleStyle: this.subtitleStyle,
            subtitleTrackHint: this.subtitleTrackHint,
            showEpisodeLanguages: this.showEpisodeLanguages,
            showAnnotationMarkers: this.showAnnotationMarkers,
            autoShowAnnotations: this.autoShowAnnotations,
            volume: this.volume,
            isMuted: this.isMuted,
            nextEpisodeCountdownSeconds: this.nextEpisodeCountdownSeconds,
            nextEpisodeCountdownSecondsDefault: this.nextEpisodeCountdownSecondsDefault,
            showNextEpisodePopup: this.showNextEpisodePopup,
            nextEpisodePromptLeadSeconds: this.nextEpisodePromptLeadSeconds,
            noOutroFallbackSeconds: this.noOutroFallbackSeconds,
            seekStepSeconds: this.seekStepSeconds,
            autoDismissNextEpisodePopup: this.autoDismissNextEpisodePopup,
            stillWatchingEnabled: this.stillWatchingEnabled,
            updatedAt: this.updatedAt,
        };
    }

    /**
     * Apply a server (or cross-tab) snapshot, skipping any key the user has
     * modified locally (PS-003) and any client-owned field (PS-013).
     * Undefined server values are skipped so a partial snapshot can't clobber
     * a defined local value with `undefined`.
     */
    #mergeFromServer(prefs: PlaybackPreferences, persist = true): void {
        if (!currentPreferenceContext()) return;
        const current = this.#snapshot();
        const merged = { ...current };
        const mergedRec = merged as unknown as Record<string, unknown>;
        const prefsRec = prefs as unknown as Record<string, unknown>;
        for (const k of Object.keys(prefs) as Array<keyof PlaybackPreferences>) {
            if (LOCAL_ONLY_FIELDS.has(k)) continue;
            if (dirtyKeys.has(k)) continue;
            if (prefsRec[k] === undefined) continue;
            if (JSON.stringify(current[k]) !== JSON.stringify(prefs[k])) {
                revisionCounter += 1;
                if (AUDIO_PREFERENCE_KEYS.some((key) => key === k))
                    selectionRevisions.audio = revisionCounter;
                if (SUBTITLE_PREFERENCE_KEYS.some((key) => key === k))
                    selectionRevisions.subtitle = revisionCounter;
            }
            mergedRec[k] = prefsRec[k];
        }
        this.#applyPreferences(merged);
        if (persist) saveToLocalStorage(merged);
    }

    #storageFailure(): void {
        this.storageUnavailable = true;
        this.ready = false;
        serverLoaded = false;
    }

    #markDirty<K extends keyof PlaybackPreferences>(key: K): void {
        if (
            !currentPreferenceContext() ||
            !Object.hasOwn(DEFAULT_PREFERENCES, key) ||
            LOCAL_ONLY_FIELDS.has(key)
        )
            return;
        revisionCounter += 1;
        dirtyKeys.set(key, revisionCounter);
        if (AUDIO_PREFERENCE_KEYS.some((candidate) => candidate === key))
            selectionRevisions.audio = revisionCounter;
        if (SUBTITLE_PREFERENCE_KEYS.some((candidate) => candidate === key))
            selectionRevisions.subtitle = revisionCounter;
        const edit = preferenceJournal?.record(key, this.#snapshot()[key], revisionCounter);
        if (edit) unpersistedDirty.delete(key);
        else if (this.#snapshot()[key] !== undefined) {
            unpersistedDirty.add(key);
            this.#storageFailure();
        } else unpersistedDirty.delete(key);
        if (edit)
            pendingJournalEntries.set(key, [
                ...(pendingJournalEntries.get(key) ?? []).filter(
                    (previous) => previous.owner !== preferenceJournal?.owner,
                ),
                edit,
            ]);
    }

    #scheduleFlush(): void {
        if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
        saveDebounceTimer = setTimeout(() => {
            saveDebounceTimer = null;
            void this.#flushDirty();
        }, DEBOUNCE_MS);
    }

    #buildDirtyPayload(
        sending: Map<keyof PlaybackPreferences, number>,
    ): Partial<PlaybackPreferencesInput> {
        const snapshot = this.#snapshot() as unknown as Record<string, unknown>;
        const payload: Record<string, unknown> = {};
        for (const key of sending.keys()) {
            if (LOCAL_ONLY_FIELDS.has(key)) continue;
            // Skip `undefined`. JSON.stringify DELETES undefined-valued keys, so such a
            // key counts toward the caller's `Object.keys(payload).length === 0` guard
            // but vanishes on the wire — the server then receives `{}` and 422s on
            // playbackPreferencesSchema's "At least one preference field must be
            // provided" refine, with no field name to explain it.
            //
            // This is DEFENSIVE, not a fix for a diagnosed producer. `updatePreference`
            // and `updatePreferences` assign whatever they are handed straight onto the
            // store, so any caller passing `undefined` lands here; no such caller is
            // known in the tracked graph, and the 422 observed in production is NOT
            // explained by this path (see the note on saveToServer's logging).
            //
            // `null` is deliberately NOT skipped, but note that is not the same as
            // "null is always safe": only fields declared `.nullable()` in
            // playbackPreferencesSchema accept it. `qualityMode` and every boolean are
            // `.optional()` WITHOUT `.nullable()`, so a null there produces the same
            // opaque 422 this guard exists to avoid. Skipping null blindly would
            // instead break the fields where null genuinely means "clear it", so the
            // real protection is the field-level logging below.
            if (snapshot[key] === undefined) continue;
            payload[key] = snapshot[key];
        }
        return payload as Partial<PlaybackPreferencesInput>;
    }

    /**
     * Flush all currently-dirty keys to the server. On success, clear each
     * key only if its revision hasn't advanced in the meantime (a same-key
     * edit during the in-flight request bumps the revision; that key must
     * stay dirty so the next debounce picks it up).
     */
    #flushTail: Promise<void> = Promise.resolve();

    #flushDirty(): Promise<boolean> {
        // Snapshot only after earlier writes settle, preventing stale writes from
        // reaching storage after a newer choice has already been marked clean.
        const epoch = preferenceEpoch;
        const signal = preferenceWriteAbort.signal;
        const account = preferenceJournal?.epoch ?? 'unavailable';
        const result = this.#flushTail.then(async () => {
            if (epoch !== preferenceEpoch || !currentPreferenceContext()) return false;
            if (dirtyKeys.size === 0) return true;
            try {
                const identityReady = await withPreferenceWriteLock(
                    'bootstrap',
                    async () => {
                        if (epoch !== preferenceEpoch || !currentPreferenceContext()) return false;
                        try {
                            preferenceJournal?.ensureBrowserIdentity();
                            return true;
                        } catch {
                            this.#storageFailure();
                            return false;
                        }
                    },
                    signal,
                );
                if (!identityReady) return false;
                return await withPreferenceWriteLock(
                    account,
                    async (requestSignal) => {
                        if (epoch !== preferenceEpoch || !currentPreferenceContext()) return false;
                        if (!this.#reconcileDirtyJournal()) return false;
                        return this.#flushOnce(epoch, requestSignal);
                    },
                    signal,
                );
            } catch {
                return false;
            } // Journals survive unavailable coordination/cleanup.
        });
        this.#flushTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    #reconcileDirtyJournal(): boolean {
        if (!preferenceJournal) return false;
        for (const key of unpersistedDirty) {
            const edit = preferenceJournal.record(
                key,
                this.#snapshot()[key],
                dirtyKeys.get(key) ?? revisionCounter,
            );
            if (!edit) {
                this.#storageFailure();
                return false;
            }
            unpersistedDirty.delete(key);
        }
        const current = preferenceJournal.entries();
        for (const key of [...dirtyKeys.keys()]) {
            const represented = current.filter((edit) => edit.field === key);
            const winner = represented.at(-1);
            const acknowledged = winner ? undefined : preferenceJournal.acknowledged(key);
            const value = winner ? winner.value : acknowledged?.value;
            if (winner || acknowledged) {
                const normalized = normalizePreferences({ [key]: value });
                if (normalized) {
                    (this as unknown as Record<string, unknown>)[key] = normalized[key];
                    if (key === 'qualityMode')
                        this.#lastPersistedQualityMode = normalized.qualityMode;
                }
            }
            if (winner) pendingJournalEntries.set(key, represented);
            else if (acknowledged) {
                dirtyKeys.delete(key);
                pendingJournalEntries.delete(key);
            }
        }
        return true;
    }

    async #flushOnce(epoch: number, signal?: AbortSignal): Promise<boolean> {
        if (dirtyKeys.size === 0) return true;

        const sending = new Map(dirtyKeys);
        const payload = this.#buildDirtyPayload(sending);
        const represented = [...sending.keys()]
            .flatMap((key) => pendingJournalEntries.get(key) ?? [])
            .filter((edit) => Object.hasOwn(payload, edit.field));
        if (Object.keys(payload).length === 0) {
            // Nothing sendable. Either every entry was a LOCAL_ONLY_FIELD (stale
            // rehydrated state — #markDirty filters these) or every value was
            // undefined, which #buildDirtyPayload skips because JSON.stringify would
            // drop it and the server would 422 an empty body. Clearing is right in
            // both cases: an undefined value is not a pending edit, and a later real
            // edit re-marks the key.
            for (const k of sending.keys()) dirtyKeys.delete(k);
            return true;
        }

        if (!preferenceJournal?.isCurrent()) return false;
        const fields: NonNullable<PlaybackPreferencesInput['writeOrder']>['fields'] = {};
        for (const key of Object.keys(payload)) {
            const winner = represented.filter((edit) => edit.field === key).at(-1);
            if (!winner) return false; // No network write without its durable immutable edit.
            fields[key] = { clock: winner.updatedAt, operationId: winner.id };
        }
        const deviceId = preferenceJournal.browserIdentity();
        if (!deviceId) {
            this.#storageFailure();
            return false;
        }
        const orderedPayload = {
            ...payload,
            writeOrder: {
                deviceId,
                epochGeneration: preferenceJournal.generation,
                epochId: preferenceJournal.epoch,
                fields,
            },
        };
        const ok = await saveToServer(orderedPayload, signal);
        if (!ok || epoch !== preferenceEpoch || !currentPreferenceContext()) return false;

        if (
            preferenceJournal &&
            !preferenceJournal.acknowledge(represented, payload as Record<string, unknown>)
        ) {
            // A successful PATCH still needs a durable watermark before retiring
            // its replay entries. Reclaim redundant snapshots while holding the
            // write lock, then retry without another HTTP request or cache refill.
            preferenceJournal.recoverStorage();
            if (!preferenceJournal.acknowledge(represented, payload as Record<string, unknown>)) {
                this.#storageFailure();
                return false;
            }
        }
        for (const [key, sentRev] of sending) {
            // Clear only what actually WENT. A key whose snapshot value was undefined
            // is skipped by #buildDirtyPayload, and clearing it here would mark it
            // clean without the server ever seeing it. The revision check below
            // already covers a concurrent edit during the await (that bumps the rev),
            // but not a value that changed via a path which does not mark dirty —
            // #lastPersistedQualityMode is mutated directly and silently changes what
            // the snapshot yields for qualityMode.
            if (!Object.hasOwn(payload, key)) continue;
            if (dirtyKeys.get(key) === sentRev) {
                dirtyKeys.delete(key);
            }
        }
        const acknowledged = new Set(represented.map((edit) => edit.storageKey));
        for (const key of sending.keys())
            pendingJournalEntries.set(
                key,
                (pendingJournalEntries.get(key) ?? []).filter(
                    (edit) => !acknowledged.has(edit.storageKey),
                ),
            );
        return true;
    }

    /**
     * Initialize preferences (load from localStorage first, then sync with server).
     * Concurrent callers share a single in-flight promise so rapid remounts
     * don't race the fetch path.
     */
    async initialize(): Promise<void> {
        // Only explicit initialization can rebase a retired account. Ordinary
        // queued saves merely fail their captured context and retain no old edits.
        if (preferenceJournal && !preferenceJournal.isCurrent()) this._invalidateAccount();
        if (initializePromise) return initializePromise;
        const epoch = preferenceEpoch;
        const signal = preferenceWriteAbort.signal;
        const recover = !!preferenceJournal && !preferenceJournal.isCurrent();
        const pending = this.#initializeContext(epoch, signal, recover).finally(() => {
            if (initializePromise === pending) initializePromise = null;
        });
        initializePromise = pending;
        return pending;
    }

    async #initializeContext(epoch: number, signal: AbortSignal, recover: boolean): Promise<void> {
        this.loading = true;
        try {
            const active = await withPreferenceWriteLock(
                'bootstrap',
                async () => {
                    if (epoch !== preferenceEpoch) return false;
                    if (!recover && preferenceJournal && !preferenceJournal.isCurrent())
                        return false;
                    if (!preferenceJournal?.bootstrap()) {
                        this.#storageFailure();
                        return false;
                    }
                    try {
                        preferenceJournal.ensureBrowserIdentity();
                    } catch {
                        preferenceJournal.recoverStorage();
                        try {
                            preferenceJournal.ensureBrowserIdentity();
                        } catch {
                            this.#storageFailure();
                            return false;
                        }
                    }
                    // Persist every in-memory edit before the settings gate can reopen.
                    if (unpersistedDirty.size) {
                        preferenceJournal.recoverStorage();
                        if (!this.#reconcileDirtyJournal()) return false;
                    }
                    if (!preferenceJournal.migrateLegacy(LOCAL_STORAGE_KEY)) {
                        preferenceJournal.recoverStorage();
                        if (!preferenceJournal.migrateLegacy(LOCAL_STORAGE_KEY)) {
                            this.#storageFailure();
                            return false;
                        }
                    }
                    return true;
                },
                signal,
            );
            if (epoch !== preferenceEpoch) return;
            if (!active) {
                if (preferenceJournal && !preferenceJournal.isCurrent()) this._invalidateAccount();
                this.#storageFailure();
                return;
            }
            this.storageUnavailable = false;
            if (serverLoaded && this.ready) return;
            const activating = !preferenceActive;
            this.#adoptReplay();
            await this.#initializeOnce(epoch, activating);
        } catch {
            if (epoch === preferenceEpoch) this.#storageFailure();
        } finally {
            if (epoch === preferenceEpoch) this.loading = false;
        }
    }

    async #initializeOnce(epoch: number, activating: boolean): Promise<void> {
        this.loading = true;

        // Step 1: Read local cache. The constructor already applied
        // localStorage to the store on module load, so we don't call
        // #applyPreferences again here — doing so would clobber any edits
        // the user made between module load and this call (R2).
        const localPrefs = getInitialPreferences();

        // Step 2: Fetch from server in background
        try {
            const result = await loadFromServer();
            if (epoch !== preferenceEpoch || (preferenceJournal && !preferenceJournal.isCurrent()))
                return;
            // A cleaned-up tab resumes only after the new account's read
            // succeeds; a signed-out/failed read cannot unlock old-tab writes.
            if (activating) {
                if (!result.ok) return;
                preferenceActive = true;
            }
            if (!currentPreferenceContext()) return;
            if (result.ok) this.ready = true;
            const serverPrefs = result.ok ? result.preferences : null;

            if (!result.ok) {
                // Keep retrying reads on a later initialize; only explicit dirty edits may flush.
            } else if (serverPrefs && serverPrefs.updatedAt) {
                // Server has preferences — merge, skipping dirty + local-only keys.
                this.#mergeFromServer(serverPrefs);
                serverLoaded = true;
                console.log('[PreferencesSync] Loaded preferences from server');
            } else if (hasCustomPreferences(localPrefs)) {
                // No server preferences but we have local — migrate entire
                // local snapshot to the server by marking every non-local
                // field dirty, then flush.
                console.log('[PreferencesSync] Migrating local preferences to server');
                for (const key of Object.keys(localPrefs) as Array<keyof PlaybackPreferences>) {
                    if (LOCAL_ONLY_FIELDS.has(key)) continue;
                    if (dirtyKeys.has(key)) continue;
                    this.#markDirty(key);
                }
                serverLoaded = true;
            } else {
                serverLoaded = true;
            }

            // Step 3 (PS-012): replay any still-dirty entries. Covers
            // dropped beacons, tab closed before debounce fired, and fresh
            // migrations from the local→server step above.
            if (dirtyKeys.size > 0) {
                await this.#flushDirty();
            }
        } catch (e) {
            console.warn('[PreferencesSync] Server sync failed, using local:', e);
        } finally {
            if (epoch === preferenceEpoch) this.loading = false;
        }
    }

    /**
     * Update a preference (saves to localStorage immediately, debounces server flush).
     */
    updatePreference<K extends keyof PlaybackPreferences>(
        key: K,
        value: PlaybackPreferences[K],
    ): void {
        if (!currentPreferenceContext()) return;
        (this as unknown as Record<string, unknown>)[key] = value;

        // Defence in depth (see #snapshot()): a qualityMode write of
        // 'audio-only' must never dirty the key, or a debounced flush would
        // sync it to the server. In normal operation this branch is dead —
        // playerStore.setQualityProfile never calls updatePreferences() for
        // an audio-only selection — but this generic setter has no way to
        // know that, so it guards independently.
        if (key === 'qualityMode' && (value as unknown as string) === 'audio-only') {
            saveToLocalStorage(this.#snapshot());
            return;
        }
        if (key === 'qualityMode') {
            this.#lastPersistedQualityMode = value as PlaybackPreferences['qualityMode'];
        }

        saveToLocalStorage(this.#snapshot());
        this.#markDirty(key);
        this.#scheduleFlush();
    }

    /**
     * Update multiple preferences at once (single debounced flush).
     */
    updatePreferences(updates: Partial<PlaybackPreferences>): void {
        if (!currentPreferenceContext()) return;
        if (Object.keys(updates).length === 0) return;

        for (const [key, value] of Object.entries(updates)) {
            (this as unknown as Record<string, unknown>)[key] = value;

            // Defence in depth (see #snapshot() and updatePreference()):
            // never dirty a qualityMode key carrying 'audio-only'.
            if (key === 'qualityMode' && (value as unknown as string) === 'audio-only') {
                continue;
            }
            if (key === 'qualityMode') {
                this.#lastPersistedQualityMode = value as PlaybackPreferences['qualityMode'];
            }
            this.#markDirty(key as keyof PlaybackPreferences);
        }

        saveToLocalStorage(this.#snapshot());
        this.#scheduleFlush();
    }

    /**
     * Force immediate sync to server (for critical changes).
     */
    async forceSyncToServer(): Promise<boolean> {
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }
        return this.#flushDirty();
    }

    /**
     * Get current preferences as a snapshot object
     */
    getPreferences(): PlaybackPreferences {
        return this.#snapshot();
    }

    // ---------------------------------------------------------------------
    // Internal accessors for unload / storage-event hooks below.
    // Using `as unknown as` to cross the module boundary without exposing
    // private methods publicly.
    // ---------------------------------------------------------------------

    /** @internal — for unload handlers */
    _buildDirtyPayload(): Partial<PlaybackPreferencesInput> {
        return this.#buildDirtyPayload(new Map(dirtyKeys));
    }

    /** @internal — for unload / visibility handlers */
    async _flushDirty(): Promise<boolean> {
        return this.#flushDirty();
    }

    /** @internal — for cross-tab `storage` event */
    _mergeFromServer(prefs: PlaybackPreferences): void {
        this.#mergeFromServer(prefs, false);
    }

    /** @internal — invalidate async work at the actual account cleanup boundary. */
    _invalidateAccount(): void {
        preferenceEpoch += 1;
        preferenceWriteAbort.abort();
        preferenceWriteAbort = new AbortController();
        preferenceActive = false;
        this.ready = false;
        if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
        dirtyKeys.clear();
        pendingJournalEntries.clear();
        unpersistedDirty.clear();
        preferenceJournal?.refreshEpoch();
        selectionRevisions.audio = ++revisionCounter;
        selectionRevisions.subtitle = ++revisionCounter;
        serverLoaded = false;
        initializePromise = null;
        this.#flushTail = Promise.resolve();
        this.loading = false;
        this.#applyPreferences({
            ...DEFAULT_PREFERENCES,
            volume: this.volume,
            isMuted: this.isMuted,
        });
    }
}

export const playbackPreferences = new PlaybackPreferencesStore();

if (isBrowser) {
    window.addEventListener('lumastra:user-client-state-cleared', () =>
        playbackPreferences._invalidateAccount(),
    );
    // ---------------------------------------------------------------------
    // Unload flushers — keyed on dirty state, not on the debounce timer.
    // A change made >DEBOUNCE_MS before unload has already fired the timer;
    // the fetch may still be in flight and may still fail, so we re-flush
    // whenever there are dirty keys (PS-004).
    // ---------------------------------------------------------------------

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') return;
        if (dirtyKeys.size === 0) return;
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }
        void playbackPreferences._flushDirty();
    });

    // All preference writes use keepalive from their first dispatch. Queue the
    // final snapshot behind the same tail so it cannot commit ahead of an older
    // in-flight edit. A discarded unload continuation leaves the persisted dirty
    // map for the next initialize(); there is no optimistic acknowledgement.
    window.addEventListener('pagehide', () => {
        if (dirtyKeys.size === 0) return;
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }
        void playbackPreferences._flushDirty();
    });

    // ---------------------------------------------------------------------
    // Cross-tab sync. Other tabs write to LOCAL_STORAGE_KEY after their own
    // flush; mirror the new snapshot here, skipping dirty + local-only keys.
    // Journal entries are adopted at initialization, never echoed as full caches.
    // ---------------------------------------------------------------------

    window.addEventListener('storage', (event) => {
        if (event.storageArea !== window.localStorage) return;
        if (event.key === PREFERENCE_EPOCH_KEY || event.key === PREFERENCE_PERMIT_KEY) {
            if (preferenceJournal && !preferenceJournal.isCurrent())
                playbackPreferences._invalidateAccount();
            return;
        }
        if (event.key !== LOCAL_STORAGE_KEY) return;
        if (!event.newValue || !currentPreferenceContext()) return;
        const parsed = preferenceJournal?.decodeCache(event.newValue);
        if (!parsed) return;
        // Quota recovery emits a compact cache. Omitted fields are unchanged,
        // rather than an instruction to reset a sibling's clean preferences.
        const normalized = normalizePreferences({
            ...playbackPreferences.getPreferences(),
            ...parsed,
        });
        if (!normalized) return;
        playbackPreferences._mergeFromServer(normalized);
    });
}

/**
 * Initialize preferences (load from localStorage first, then sync with server)
 */
export function initializePreferences(): Promise<void> {
    return playbackPreferences.initialize();
}

/**
 * Update a preference (saves to both localStorage and server with debounce)
 */
export function updatePreference<K extends keyof PlaybackPreferences>(
    key: K,
    value: PlaybackPreferences[K],
): void {
    playbackPreferences.updatePreference(key, value);
}

/**
 * Update multiple preferences at once
 */
export function updatePreferences(updates: Partial<PlaybackPreferences>): void {
    playbackPreferences.updatePreferences(updates);
}

/**
 * Force immediate sync to server (for critical changes)
 */
export function forceSyncToServer(): Promise<boolean> {
    return playbackPreferences.forceSyncToServer();
}

/**
 * Get current preferences (sync)
 */
export function getPreferences(): PlaybackPreferences {
    return playbackPreferences.getPreferences();
}
