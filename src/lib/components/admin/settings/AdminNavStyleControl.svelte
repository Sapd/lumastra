<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  "Admin navigation style" control — canonical home on Settings → General
  (admin IA redesign, spec §4/§6: "Both selectable at runtime: Settings →
  General → 'Admin navigation style', stored per admin user, switchable
  live"). The account menu's switcher (added in step:nav-manifest as a
  temporary stopgap so both renderers were exercisable before this page
  existed) is left in place too — a quick-access duplicate of the same
  `adminNavPrefs` store, not a second source of truth.
-->
<script lang="ts">
    import { page } from '$app/stores';
    import { adminNavPrefs } from '$lib/stores/admin-nav-prefs.store.svelte.js';
    import type { AdminNavStyle } from '$lib/config/admin-nav.js';
    import * as m from '$lib/paraglide/messages.js';

    let serverNavStyle = $derived(
        (($page.data as { uiPrefs?: { navStyle?: AdminNavStyle } } | undefined)?.uiPrefs
            ?.navStyle ?? 'sidebar') as AdminNavStyle,
    );
    let navStyle = $derived(adminNavPrefs.resolveStyle(serverNavStyle));

    async function pickNavStyle(style: AdminNavStyle): Promise<void> {
        await adminNavPrefs.setStyle(style);
    }
</script>

<div class="rounded-lg border border-surface-700/60 bg-surface-800/30 p-4">
    <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-surface-200">
        {m.admin_nav_style_label()}
        <span
            class="rounded border border-surface-600 px-1.5 py-0.5 text-xs font-normal text-surface-400"
            >{m.admin_nav_style_personal_badge()}</span>
    </p>
    <p class="text-xs text-surface-500 mt-0.5">{m.admin_nav_style_help()}</p>
    <div class="mt-3 inline-flex gap-1 rounded-lg bg-surface-900/60 p-1">
        <button
            type="button"
            class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors {navStyle ===
            'sidebar'
                ? 'bg-yellow-500 text-surface-900'
                : 'text-surface-300 hover:text-white'}"
            onclick={() => void pickNavStyle('sidebar')}>
            {m.admin_nav_style_sidebar()}
        </button>
        <button
            type="button"
            class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors {navStyle === 'mega'
                ? 'bg-yellow-500 text-surface-900'
                : 'text-surface-300 hover:text-white'}"
            onclick={() => void pickNavStyle('mega')}>
            {m.admin_nav_style_mega()}
        </button>
    </div>
</div>
