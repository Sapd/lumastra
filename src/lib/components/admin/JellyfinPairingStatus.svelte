<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    let {
        status,
    }: {
        status: {
            count: number;
            examples: string[];
            failed?: { count: number; examples: string[] };
            oneSided?: number;
        } | null;
    } = $props();
</script>

{#if status === null}
    <p role="status" class="mb-6 text-amber-300">{m.admin_jellyfin_pairing_status_unavailable()}</p>
{:else if status.count > 0}
    <section
        class="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
        aria-label={m.admin_jellyfin_not_paired_label()}>
        <h2 class="font-semibold text-amber-200">
            {m.admin_jellyfin_not_paired({ count: status.count })}
        </h2>
        <p class="mt-2 text-sm text-surface-200">{m.admin_jellyfin_not_paired_hint()}</p>
        <ul class="mt-2 list-inside list-disc text-sm text-surface-200">
            {#each status.examples as title (title)}
                <li>{title}</li>
            {/each}
        </ul>
    </section>
{/if}

{#if status?.failed?.count}
    <section
        class="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
        aria-label={m.admin_jellyfin_delivery_failed({ count: status.failed.count })}>
        <h2 class="font-semibold text-amber-200">
            {m.admin_jellyfin_delivery_failed({ count: status.failed.count })}
        </h2>
        <ul class="mt-2 list-inside list-disc text-sm text-surface-200">
            {#each status.failed.examples as reason (reason)}<li>{reason}</li>{/each}
        </ul>
    </section>
{/if}
{#if status?.oneSided}
    <p class="mb-6 text-sm text-surface-200">
        {m.admin_jellyfin_one_sided({ count: status.oneSided })}
    </p>
{/if}
