<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Z } from '$lib/utils/z-index';
    import { maintenanceNotice } from '$lib/stores/maintenance-notice.store.svelte.js';
    import { formatCountdown } from '$lib/utils/countdown.js';
    import { Icon, WrenchScrewdriver } from 'svelte-hero-icons';

    // Approach: the banner uses `position: fixed` at the top of the viewport.
    // We accept minor overlap with the top of page content rather than
    // manipulating body padding, which would require measuring banner height
    // reactively across breakpoints and risk layout jank during SSR hydration.

    // `now` is updated every second by $effect so $derived below recomputes.
    let now = $state(Date.now());

    $effect(() => {
        if (!maintenanceNotice.notice) return;
        const id = setInterval(() => {
            now = Date.now();
        }, 1000);
        return () => clearInterval(id);
    });

    let countdown = $derived(
        maintenanceNotice.notice ? formatCountdown(maintenanceNotice.notice.endsAt - now) : '',
    );

    // Auto-clear via $effect when the notice has elapsed
    $effect(() => {
        if (maintenanceNotice.notice && maintenanceNotice.notice.endsAt <= now) {
            maintenanceNotice.clear();
        }
    });
</script>

{#if maintenanceNotice.notice}
    <div
        role="status"
        aria-live="polite"
        class="fixed left-0 right-0 top-0 flex items-center justify-center gap-3 border-b border-amber-700 bg-amber-900/90 px-4 py-2 text-sm text-amber-100 backdrop-blur-sm"
        style="z-index: {Z.ADMIN_BANNER}">
        <Icon src={WrenchScrewdriver} class="h-4 w-4 shrink-0 text-amber-300" solid />
        <span class="font-medium">{maintenanceNotice.notice.message}</span>
        <span class="ml-2 shrink-0 font-mono text-amber-300">{countdown}</span>
    </div>
{/if}
