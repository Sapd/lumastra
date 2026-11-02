<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import { page } from '$app/state';
    import { Icon, ExclamationTriangle, XMark } from 'svelte-hero-icons';
    import { getConfigHealth } from '$lib/api/admin';
    import type { ConfigHealthResponse } from '$lib/schemas/api-admin-responses.js';
    import * as m from '$lib/paraglide/messages.js';

    // Surfaces the config doctor report (same checks as `npm run doctor` and the
    // container boot STEP 0) so a misconfiguration — e.g. EMBEDDING_DIMENSIONS
    // not matching the model — is visible in the admin UI, not just the logs.
    //
    // Re-checked every 5 minutes, when the tab becomes visible again, and after
    // page data reloads (a settings save invalidates it), so a fixed or newly
    // broken config shows without a full reload. A failed check is shown as
    // such — it used to look exactly like "no issues".

    const POLL_MS = 5 * 60 * 1000;
    // Page-data changes come in bursts (navigation + invalidate); one check is enough.
    const MIN_GAP_MS = 10_000;

    let report = $state<ConfigHealthResponse | null>(null);
    let checkFailed = $state(false);
    let dismissed = $state(false);
    let lastCheckAt = 0;
    let seq = 0;

    async function check(force = false): Promise<void> {
        if (!force && Date.now() - lastCheckAt < MIN_GAP_MS) return;
        lastCheckAt = Date.now();
        const my = ++seq;
        const { data } = await getConfigHealth();
        if (my !== seq) return;
        checkFailed = !data;
        if (data) report = data;
    }

    onMount(() => {
        void check(true);
        const timer = setInterval(() => void check(true), POLL_MS);
        const onVisible = (): void => {
            if (document.visibilityState === 'visible') void check();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    });

    $effect(() => {
        void page.data;
        untrack(() => void check());
    });

    // Show only when there is something actionable.
    const visible = $derived(!dismissed && report !== null && report.issues.length > 0);
    // Errors make it a red, harder-to-ignore banner; warnings are amber.
    const hasErrors = $derived((report?.errorCount ?? 0) > 0);
</script>

{#if checkFailed && !report}
    <div
        class="mb-6 flex items-center gap-3 rounded-lg border border-surface-700 bg-surface-900/40 px-4 py-2 text-sm text-surface-300"
        role="status">
        {m.admin_config_health_unavailable()}
        <button
            type="button"
            class="underline hover:text-surface-100"
            onclick={() => void check(true)}>
            {m.common_retry()}
        </button>
    </div>
{/if}
{#if visible && report}
    <div
        class="mb-6 rounded-lg border p-4 {hasErrors
            ? 'border-red-700/60 bg-red-900/20'
            : 'border-amber-700/60 bg-amber-900/20'}"
        role="alert">
        <div class="flex items-start gap-3">
            <Icon
                src={ExclamationTriangle}
                class="w-5 h-5 shrink-0 mt-0.5 {hasErrors ? 'text-red-400' : 'text-amber-400'}" />
            <div class="min-w-0 flex-1">
                <h3 class="font-medium text-white">
                    {hasErrors
                        ? 'Configuration error — some features may not work'
                        : 'Configuration warning'}
                </h3>
                <ul class="mt-2 space-y-2 text-sm">
                    {#each report.issues as issue (issue.code)}
                        <li>
                            <span
                                class={issue.severity === 'error'
                                    ? 'text-red-300'
                                    : 'text-amber-300'}>
                                {issue.message}
                            </span>
                            {#if issue.remediation}
                                <span class="block text-surface-400 mt-0.5">
                                    → {issue.remediation}
                                </span>
                            {/if}
                        </li>
                    {/each}
                </ul>
            </div>
            {#if !hasErrors}
                <button
                    type="button"
                    class="btn btn-ghost btn-sm btn-square shrink-0"
                    onclick={() => (dismissed = true)}
                    aria-label="Dismiss">
                    <Icon src={XMark} class="w-4 h-4" />
                </button>
            {/if}
        </div>
    </div>
{/if}
