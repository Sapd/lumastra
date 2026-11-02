// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { untrack } from 'svelte';
import { configSections } from '$lib/config/schema';
import {
    buildCommandPaletteResults,
    type PaletteDestination,
} from '$lib/utils/admin/command-palette';
import type { AdminNavSection, NavGateContext } from '$lib/config/admin-nav';
import {
    buildSettingDeepLink,
    buildProviderDeepLink,
    type SettingSearchMatch,
    type ProviderSearchEntry,
} from '$lib/utils/admin/settings-search';
import type { RecentEntry } from '$lib/utils/admin/command-palette-recents';

export type FlatPaletteItem =
    | { kind: 'page'; href: string; dest: PaletteDestination }
    | { kind: 'setting'; href: string; match: SettingSearchMatch }
    | { kind: 'provider'; href: string; entry: ProviderSearchEntry }
    | { kind: 'recent'; href: string; entry: RecentEntry };

export interface CommandPaletteControllerDeps {
    navSections: () => AdminNavSection[];
    navGate: () => NavGateContext;
    providerIndex: () => ProviderSearchEntry[];
    devFeaturesEnabled: () => boolean;
    getRecents: () => RecentEntry[];
}

/**
 * Reactive search state shared by AdminCommandPalette (Ctrl+K modal) and
 * AdminHomeSearchBar (inline home-page bar). Owns query/selection/results
 * only — NOT open/close/focus lifecycle, since a modal and an inline bar
 * close differently.
 */
export class CommandPaletteController {
    // Definite-assignment assertion: `$derived` field initializers below read
    // `this.#deps` as a lazy expression (evaluated on first access, after the
    // constructor has run), not eagerly during field initialization — but the
    // checker's static analysis can't see that laziness and flags TS2729
    // without this assertion. The constructor always assigns `#deps` before
    // any derived value is actually read.
    #deps!: CommandPaletteControllerDeps;

    #query = $state('');
    selectedIndex = $state(0);
    // A real $state cache, NOT read directly from `getRecents()` inside a $derived.
    // This controller is a long-lived singleton (one instance per admin session,
    // shared across every open/close cycle) — `getRecents()` reads localStorage,
    // which is not a tracked reactive source, so a $derived gated only on `query`
    // silently goes stale whenever `reset()`'s `query = ''` write is a no-op
    // (query was already empty — the common case of reopening without typing).
    // Caching in `$state` and reassigning it explicitly in `reset()` guarantees a
    // fresh read every time the palette/bar opens, regardless of `query`'s value.
    #recentsCache = $state<RecentEntry[]>([]);

    get query(): string {
        return this.#query;
    }

    /** Typing starts over at the top result, so Enter opens the best match. */
    set query(value: string) {
        // untrack: `reset()` runs inside the palette's open-effect, which must not
        // start tracking the query through this comparison.
        if (value === untrack(() => this.#query)) return;
        this.#query = value;
        this.selectedIndex = 0;
    }

    constructor(deps: CommandPaletteControllerDeps) {
        this.#deps = deps;
        this.#recentsCache = deps.getRecents();
    }

    results = $derived(
        buildCommandPaletteResults({
            navSections: this.#deps.navSections(),
            navGate: this.#deps.navGate(),
            configSections,
            providerIndex: this.#deps.providerIndex(),
            query: this.query,
            flags: { devFeaturesEnabled: this.#deps.devFeaturesEnabled(), showAdvanced: true },
        }),
    );

    /** Up to 5 recently-activated items — browse mode (empty query) only. */
    recents = $derived(this.query.trim() === '' ? this.#recentsCache : []);

    flat: FlatPaletteItem[] = $derived([
        ...this.recents.map((entry) => ({ kind: 'recent' as const, href: entry.href, entry })),
        ...this.results.pages.map((dest) => ({ kind: 'page' as const, href: dest.href, dest })),
        ...this.results.settings.map((match) => ({
            kind: 'setting' as const,
            href: buildSettingDeepLink(match),
            match,
        })),
        ...this.results.providers.map((entry) => ({
            kind: 'provider' as const,
            href: buildProviderDeepLink(entry),
            entry,
        })),
    ]);

    pagesOffset = $derived(this.recents.length);
    settingsOffset = $derived(this.recents.length + this.results.pages.length);
    providersOffset = $derived(
        this.recents.length + this.results.pages.length + this.results.settings.length,
    );

    /** Reset query + selection, and force a fresh recents read (call on open/expand). */
    reset(): void {
        this.query = '';
        this.selectedIndex = 0;
        this.#recentsCache = this.#deps.getRecents();
    }

    /** Clamp selection after results shrink (call from an $effect on `flat`). */
    clampSelection(): void {
        if (this.selectedIndex >= this.flat.length) {
            this.selectedIndex = Math.max(0, this.flat.length - 1);
        }
    }

    /** Move the selection by `delta`, clamped to the flat list bounds. */
    moveSelection(delta: number): void {
        if (this.flat.length === 0) {
            this.selectedIndex = 0;
            return;
        }
        this.selectedIndex = Math.min(
            Math.max(this.selectedIndex + delta, 0),
            this.flat.length - 1,
        );
    }

    /** The item at `index` (defaults to the current selection). */
    itemAt(index: number = this.selectedIndex): FlatPaletteItem | undefined {
        return this.flat[index];
    }
}

/** Maps a live result to the storable shape recorded on activation. */
export function toRecentEntry(item: FlatPaletteItem): Omit<RecentEntry, 'timestamp'> {
    switch (item.kind) {
        case 'page':
            return {
                kind: 'page',
                href: item.href,
                label: item.dest.parentTitle
                    ? `${item.dest.parentTitle} › ${item.dest.title}`
                    : item.dest.title,
                sectionLabel: item.dest.sectionTitle,
            };
        case 'setting':
            return {
                kind: 'setting',
                href: item.href,
                label: item.match.setting.label,
                sectionLabel: item.match.pageLabel,
            };
        case 'provider':
            return {
                kind: 'provider',
                href: item.href,
                label: item.entry.label,
                sectionLabel: item.entry.category,
            };
        case 'recent':
            // Re-activating an already-shown recent — reuse its own stored label/section.
            return {
                kind: item.entry.kind,
                href: item.entry.href,
                label: item.entry.label,
                sectionLabel: item.entry.sectionLabel,
            };
    }
}
