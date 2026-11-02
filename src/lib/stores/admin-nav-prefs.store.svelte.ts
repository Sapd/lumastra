// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin nav preferences store (admin IA redesign, spec §4).
 *
 * Holds the live-switchable admin navigation style (sidebar | mega) plus the
 * sidebar's rail-collapse state. The nav style is a PER-USER server preference
 * (loaded in `+layout.server.ts` → `data.uiPrefs.navStyle`); this store keeps
 * only a client-side OVERRIDE that wins once the user switches live — so the SSR
 * render uses the server value (no flash) and the layout can derive the active
 * style as `override ?? serverStyle`.
 *
 * Collapse model (spec §4 "pin-collapsible to a slim rail; auto-collapses below
 * a width breakpoint"): `pinnedCollapsed` is the persisted manual pin; the
 * effective `collapsed` is forced true below the breakpoint and otherwise
 * follows the pin.
 *
 * Expanded sections (sidebar sub-page lists): the sections the user opened
 * with a row's chevron, persisted in localStorage keyed by username so two
 * admins sharing a browser keep their own. Deliberately NOT wiped at logout
 * (clear-user-client-state.ts): the per-user key is what makes it survive a
 * sign-out, and it only records which nav sections were open. The ACTIVE
 * section is always shown open by the sidebar and is not part of this set.
 */

import { browser } from '$app/environment';
import { setAdminNavStyle } from '$lib/api/admin.js';
import type { AdminNavStyle } from '$lib/config/admin-nav.js';

const COLLAPSED_KEY = 'admin-nav-collapsed';
const EXPANDED_KEY_PREFIX = 'admin-nav-expanded:';

// Storage can throw (blocked site data, private mode, quota): prefs then
// simply don't persist.
function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}
function writeStorage(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // not persisted
    }
}

function readExpanded(key: string | null): string[] {
    if (!key) return [];
    try {
        const parsed: unknown = JSON.parse(readStorage(key) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

class AdminNavPrefsStore {
    /** Null until the user switches live; then it wins over the server value. */
    #override = $state<AdminNavStyle | null>(null);
    /** Effective collapse state the sidebar renders. */
    #collapsed = $state(false);
    #hierarchyExpanded = $state(false);
    /** Persisted manual pin (restored above the auto-collapse breakpoint). */
    #pinnedCollapsed = false;
    /** Section ids opened with a sidebar chevron. */
    #expanded = $state<string[]>([]);
    /** localStorage key for #expanded (per signed-in user); null = don't persist. */
    #expandedKey: string | null = null;

    /** The client-side style override, or null to fall back to the server value. */
    get override(): AdminNavStyle | null {
        return this.#override;
    }

    /** The active nav style given the server default. */
    resolveStyle(serverStyle: AdminNavStyle): AdminNavStyle {
        return this.#override ?? serverStyle;
    }

    /** Whether the sidebar is collapsed to its slim rail. */
    get collapsed(): boolean {
        return this.#collapsed || this.#hierarchyExpanded;
    }

    /** Transient detail hierarchy ownership; never changes the operator's pin. */
    setHierarchyExpanded(expanded: boolean): void {
        this.#hierarchyExpanded = expanded;
    }

    /**
     * Read the persisted rail pin and the user's expanded sections (browser
     * only). Call from the layout onMount.
     */
    initFromStorage(username = ''): void {
        if (!browser) return;
        this.#pinnedCollapsed = readStorage(COLLAPSED_KEY) === 'true';
        this.#collapsed = this.#pinnedCollapsed;
        // No username, no persistence: never share one key between users.
        this.#expandedKey = username ? `${EXPANDED_KEY_PREFIX}${username}` : null;
        this.#expanded = readExpanded(this.#expandedKey);
    }

    /** Whether the user opened this section's page list with its chevron. */
    isExpanded(sectionId: string): boolean {
        return this.#expanded.includes(sectionId);
    }

    /** Open or close a section's page list in the sidebar (persisted). */
    toggleExpanded(sectionId: string): void {
        this.#expanded = this.#expanded.includes(sectionId)
            ? this.#expanded.filter((id) => id !== sectionId)
            : [...this.#expanded, sectionId];
        if (browser && this.#expandedKey) {
            writeStorage(this.#expandedKey, JSON.stringify(this.#expanded));
        }
    }

    /**
     * Switch nav style live and persist it (optimistic — the chrome swaps
     * immediately; a failed PATCH leaves the local override in place).
     */
    async setStyle(style: AdminNavStyle): Promise<void> {
        if (this.#override === style) return;
        this.#override = style;
        await setAdminNavStyle(style);
    }

    /** Toggle the manual rail pin (persisted; also updates the effective state). */
    toggleCollapsed(): void {
        this.#pinnedCollapsed = !this.#pinnedCollapsed;
        this.#collapsed = this.#pinnedCollapsed;
        if (browser) writeStorage(COLLAPSED_KEY, String(this.#pinnedCollapsed));
    }

    /**
     * Apply the auto-collapse breakpoint: below it the rail is forced collapsed;
     * above it the effective state returns to the manual pin.
     */
    applyBreakpoint(isNarrow: boolean): void {
        this.#collapsed = isNarrow ? true : this.#pinnedCollapsed;
    }
}

/** The one admin nav preferences store instance. */
export const adminNavPrefs = new AdminNavPrefsStore();
