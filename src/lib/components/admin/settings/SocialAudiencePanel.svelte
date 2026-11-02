<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Shows the RESOLVED effect of the Sharing & Privacy settings, not their values.

  The settings above this panel say what is configured; they do not say how many
  people that actually means. That gap is where privacy accidents live: switching
  the audience mode is a one-word edit that can change the audience by an order of
  magnitude, and nothing on the page would have told you. On the production
  instance the configured circle held 4 of 43 users — a number you could only get
  by querying the database.

  Counts only, never names. An admin can look users up elsewhere; this is here to
  make blast radius legible, and a name list would be new disclosure for no added
  clarity. (Follows AuthDiagnosticsPanel's convention of English literals — the
  admin settings surface is not translated.)
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, Eye, ExclamationTriangle } from 'svelte-hero-icons';
    import { getSocialAudience } from '$lib/api/admin';
    import type { SocialAudienceResponse } from '$lib/schemas/api-admin-library-responses';

    let result = $state<SocialAudienceResponse | null>(null);
    let failed = $state(false);

    onMount(() => {
        void getSocialAudience()
            .then(({ data, error }) => {
                if (error || !data) failed = true;
                else result = data;
            })
            .catch(() => {
                failed = true;
            });
    });

    // "Nobody" is the state worth calling out: group mode with a name that matches
    // no one looks identical to a working configuration from the settings alone.
    let isDark = $derived(result !== null && result.audienceSize === 0);
</script>

<div class="mt-4 rounded border border-surface-600/60 bg-surface-800/40 p-3">
    <div class="flex items-center gap-2">
        <Icon src={Eye} class="w-4 h-4 text-surface-400" />
        <h3 class="text-sm font-semibold text-surface-100">Who this currently reaches</h3>
    </div>

    {#if failed}
        <p class="text-xs text-surface-500 mt-2">Could not read the current audience.</p>
    {:else if result === null}
        <p class="text-xs text-surface-500 mt-2">Checking…</p>
    {:else}
        <p class="text-sm text-surface-200 mt-2">
            {#if result.mode === 'household'}
                <span class="font-semibold">Household</span> — every user on this server.
            {:else}
                <span class="font-semibold">Selected groups</span>
                {#if result.configuredGroups.length > 0}
                    — {result.configuredGroups.join(', ')}
                {/if}
            {/if}
        </p>

        <div class="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-xs text-surface-400">
            <span
                ><span class="font-mono text-surface-200">{result.audienceSize}</span> in the audience</span>
            <span
                ><span class="font-mono text-surface-200">{result.sharingCount}</span> actually sharing</span>
            {#if result.hiddenCount > 0}
                <span
                    ><span class="font-mono text-surface-200">{result.hiddenCount}</span> hidden themselves</span>
            {/if}
        </div>

        {#if isDark}
            <p class="text-xs text-warning-200 mt-2 flex items-start gap-1.5">
                <Icon src={ExclamationTriangle} class="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                    Nobody is in this audience, so listening activity is not shared at all. A group
                    name that matches no user looks the same as a working configuration from the
                    settings alone — check the names above against Access Groups.
                </span>
            </p>
        {:else if result.sharingCount === 0}
            <p class="text-xs text-surface-500 mt-2">
                {m.activity_sharing_audience_empty()}
            </p>
        {/if}
    {/if}
</div>
