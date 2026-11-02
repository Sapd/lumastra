<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import type { AdminRangeMapping } from '$lib/schemas/range-mapping-proof.js';
    import * as m from '$lib/paraglide/messages.js';
    let { mapping }: { mapping?: AdminRangeMapping } = $props();
</script>

{#if mapping}
    <div class="mt-2 space-y-1 text-xs text-surface-300" data-testid="range-mapping-diagnosis">
        {#if mapping.state === 'current' && mapping.proof}
            <p>
                {m.admin_range_current({
                    time: new Date(mapping.proof.observedAt).toLocaleString(),
                })}
            </p>
            <p>{m.admin_range_scope()}</p>
            <details>
                <summary class="cursor-pointer">{m.admin_range_raw()}</summary>
                <pre
                    class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(
                        mapping.proof,
                        null,
                        2,
                    )}</pre>
            </details>
        {:else}
            <p>{m.admin_range_unproven()}</p>
        {/if}
    </div>
{/if}
