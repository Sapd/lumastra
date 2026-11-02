// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared state for the Music Alchemy / Mixing Desk feature.
 *
 * Persisted fields (localStorage key 'lumastra:music-alchemy:v3'):
 *   seedTracks, avoidTracks, energy, tempo, obscurity, dockCollapsed
 *
 * Ephemeral (NOT persisted — stale/heavy after reload):
 *   brewing, hasBrewed, brewedTracks, totalDurationMs, moodAnchors
 *
 * Usage:
 *   import { musicAlchemyStore } from '$lib/stores/music-alchemy.store.svelte';
 *   // Call musicAlchemyStore.init() once from onMount in a top-level component.
 */

import { MusicTrackSchema } from '$lib/schemas/music';
import type { MusicTrack } from '$lib/schemas/music';
import type { MoodIslandAnchor } from '$lib/schemas/music-alchemy';
import { browser } from '$app/environment';
import { toasts } from '$lib/stores/toast.store';
import { brewAlchemy } from '$lib/api/music';

const STORAGE_KEY = 'lumastra:music-alchemy:v3';

export interface AlchemyPersistedState {
    seedTracks: MusicTrack[];
    avoidTracks: MusicTrack[];
    energy: number;
    tempo: number;
    obscurity: number;
    dockCollapsed: boolean;
}

class MusicAlchemyStore {
    // ── Persisted ─────────────────────────────────────────────────────────────
    seedTracks = $state<MusicTrack[]>([]);
    avoidTracks = $state<MusicTrack[]>([]);
    energy = $state(0.5);
    tempo = $state(0.5);
    obscurity = $state(0.5);
    /** Collapsed by default so new users see a slim bar, not an open console. */
    dockCollapsed = $state(true);

    // ── Ephemeral brew result (NOT persisted) ──────────────────────────────────
    brewing = $state(false);
    hasBrewed = $state(false);
    brewedTracks = $state<MusicTrack[]>([]);
    totalDurationMs = $state<number | null>(null);
    moodAnchors = $state<MoodIslandAnchor[]>([]);

    // ── Derived ───────────────────────────────────────────────────────────────
    canBrew = $derived(this.seedTracks.length > 0 && !this.brewing);
    seedCount = $derived(this.seedTracks.length);

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /** Call once from onMount in the /music page (or its layout). */
    init(): void {
        if (!browser) return;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const p = JSON.parse(raw) as Partial<AlchemyPersistedState>;
            if (Array.isArray(p.seedTracks)) this.seedTracks = p.seedTracks.filter((t) => MusicTrackSchema.safeParse(t).success);
            if (Array.isArray(p.avoidTracks)) this.avoidTracks = p.avoidTracks.filter((t) => MusicTrackSchema.safeParse(t).success);
            if (typeof p.energy === 'number') this.energy = p.energy;
            if (typeof p.tempo === 'number') this.tempo = p.tempo;
            if (typeof p.obscurity === 'number') this.obscurity = p.obscurity;
            if (typeof p.dockCollapsed === 'boolean') this.dockCollapsed = p.dockCollapsed;
        } catch {
            // Corrupt localStorage — start fresh
        }
    }

    private save(): void {
        if (!browser) return;
        try {
            const payload: AlchemyPersistedState = {
                seedTracks: this.seedTracks,
                avoidTracks: this.avoidTracks,
                energy: this.energy,
                tempo: this.tempo,
                obscurity: this.obscurity,
                dockCollapsed: this.dockCollapsed,
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        } catch {
            // localStorage quota exceeded — silently ignore
        }
    }

    // ── Seed pad ──────────────────────────────────────────────────────────────

    addToSeed(incoming: MusicTrack[]): void {
        const existingIds = new Set(this.seedTracks.map((t) => t.id));
        const novel = incoming.filter((t) => !existingIds.has(t.id));
        if (this.seedTracks.length >= 20) {
            toasts.info('Max 20 seed tracks');
            return;
        }
        const available = 20 - this.seedTracks.length;
        if (novel.length > available) {
            toasts.info('Max 20 seed tracks');
        }
        this.seedTracks = [...this.seedTracks, ...novel].slice(0, 20);
        this.save();
    }

    /** Convenience single-track wrapper for context-menu / click-add callers. */
    addSeed(track: MusicTrack): void {
        this.addToSeed([track]);
    }

    removeFromSeed(track: MusicTrack): void {
        this.seedTracks = this.seedTracks.filter((t) => t.id !== track.id);
        this.save();
    }

    // ── Avoid pad ─────────────────────────────────────────────────────────────

    addToAvoid(incoming: MusicTrack[]): void {
        const existingIds = new Set(this.avoidTracks.map((t) => t.id));
        const novel = incoming.filter((t) => !existingIds.has(t.id));
        this.avoidTracks = [...this.avoidTracks, ...novel].slice(0, 200);
        this.save();
    }

    /** Convenience single-track wrapper for context-menu / click-add callers. */
    addAvoid(track: MusicTrack): void {
        this.addToAvoid([track]);
    }

    removeFromAvoid(track: MusicTrack): void {
        this.avoidTracks = this.avoidTracks.filter((t) => t.id !== track.id);
        this.save();
    }

    // ── Knobs ─────────────────────────────────────────────────────────────────

    setEnergy(v: number): void {
        this.energy = v;
        this.save();
    }

    setTempo(v: number): void {
        this.tempo = v;
        this.save();
    }

    setObscurity(v: number): void {
        this.obscurity = v;
        this.save();
    }

    // ── Dock ──────────────────────────────────────────────────────────────────

    toggleDock(): void {
        this.dockCollapsed = !this.dockCollapsed;
        this.save();
    }

    setDockCollapsed(v: boolean): void {
        this.dockCollapsed = v;
        this.save();
    }

    // ── Brew ──────────────────────────────────────────────────────────────────

    async brew(): Promise<void> {
        if (!this.canBrew) return;
        this.brewing = true;
        try {
            const body: Parameters<typeof brewAlchemy>[0] = {
                seedIds: this.seedTracks
                    .map((t) => t.id)
                    .filter((id): id is string => typeof id === 'string' && id.length > 0),
                avoidIds: this.avoidTracks
                    .map((t) => t.id)
                    .filter((id): id is string => typeof id === 'string' && id.length > 0),
                energy: this.energy,
                tempo: this.tempo,
                obscurity: this.obscurity,
                limit: 20,
            };

            const { data: result, error, status } = await brewAlchemy(body);

            if (error || !result) {
                if (status === 404) {
                    toasts.error('Mixing Desk is not enabled on this server');
                } else {
                    toasts.error('Brew failed — please try again');
                }
                return;
            }

            this.brewedTracks = result.tracks;
            this.totalDurationMs = result.totalDurationMs ?? null;
            this.moodAnchors = result.moodAnchors;
            this.hasBrewed = true;
        } catch {
            toasts.error('Network error — could not reach the brew endpoint');
        } finally {
            this.brewing = false;
        }
    }

    // ── Utility ───────────────────────────────────────────────────────────────

    /** Reset pads only; preserves knobs and brew result. */
    clear(): void {
        this.seedTracks = [];
        this.avoidTracks = [];
        this.save();
    }

    /** Clear the brew suggestions (result) only; preserves seeds and knobs. */
    clearBrew(): void {
        this.brewedTracks = [];
        this.totalDurationMs = null;
        this.moodAnchors = [];
        this.hasBrewed = false;
    }
}

export const musicAlchemyStore = new MusicAlchemyStore();
