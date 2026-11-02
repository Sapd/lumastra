<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/wrong-match — an INTERCEPTION, not an explainer.

  This symptom is a trap. Operators reason "the metadata is wrong, so I should
  refresh the metadata", walk into the task system, and start a full refresh
  across the whole library. That does two kinds of damage at once: it queues
  every item at once (hours of provider calls and a pegged CPU on a small
  server), and it does not fix anything, because re-running the lookup re-fetches
  the SAME wrong identity. The real fix is to change which provider entry the
  item points at, which is per-item and takes seconds.

  So this page deliberately does not describe the task system, does not link to
  it, and puts the warning ABOVE the actions. Its whole job is to spend the
  operator's one click on `/admin/library/fix-matches` instead.

  The identify/match dialog has no URL of its own — it is a component the media
  browser and Fix matches open on a selected item — so "within one click" here
  means landing on the page that already holds it, in the right view.
-->
<script lang="ts">
    import { Icon, ExclamationTriangle, ArrowTopRightOnSquare } from 'svelte-hero-icons';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('wrong-match');

    // `?view=broken` / the default `never` view are the ids Fix matches
    // documents as stable ("Do not rename") — the same literals the attention
    // adapters deep-link with.
    const actions = [
        {
            label: m.admin_fix_match_cta_broken,
            path: '/admin/library/fix-matches',
            query: '?view=broken',
            primary: true,
        },
        {
            label: m.admin_fix_match_cta_never,
            path: '/admin/library/fix-matches',
            query: '',
            primary: false,
        },
        {
            label: m.admin_fix_match_cta_browser,
            path: '/admin/library/media',
            query: '',
            primary: false,
        },
    ];
</script>

{#if symptom}
    <FixPageShell
        title={symptom.title()}
        description={m.admin_fix_match_description()}
        icon={symptom.icon}>
        <div class="space-y-5">
            <p class="max-w-3xl text-sm leading-relaxed text-surface-100">
                {m.admin_fix_match_lede()}
            </p>

            <div
                class="space-y-2 rounded border border-warning-500/40 bg-warning-500/10 p-4"
                role="note">
                <p class="flex items-center gap-2 text-sm font-semibold text-warning-200">
                    <Icon src={ExclamationTriangle} class="h-4 w-4 shrink-0" />
                    <span>{m.admin_fix_match_warning_title()}</span>
                </p>
                <p class="text-xs leading-relaxed text-warning-100/90">
                    {m.admin_fix_match_warning_body()}
                </p>
            </div>

            <div class="space-y-2">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-surface-400">
                    {m.admin_fix_match_how_heading()}
                </h3>
                <ul class="space-y-2">
                    {#each actions as action (action.path + action.query)}
                        <li>
                            <a
                                href="{resolve(action.path)}{action.query}"
                                class="group flex items-center gap-2 rounded border p-3 text-sm transition-colors {action.primary
                                    ? 'border-primary-500/50 bg-primary-500/10 text-primary-100 hover:bg-primary-500/20'
                                    : 'border-surface-700/50 bg-surface-800/40 text-surface-100 hover:border-primary-500/50 hover:bg-surface-800/80'}">
                                <span class="min-w-0 flex-1">{action.label()}</span>
                                <Icon src={ArrowTopRightOnSquare} class="h-4 w-4 shrink-0" />
                            </a>
                        </li>
                    {/each}
                </ul>
                <p class="text-xs leading-relaxed text-surface-400">
                    {m.admin_fix_match_browser_hint()}
                </p>
            </div>
        </div>
    </FixPageShell>
{/if}
