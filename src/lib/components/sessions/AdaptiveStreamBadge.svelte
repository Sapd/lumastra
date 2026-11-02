<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Adaptive-bitrate (ABR) state of one play session: the variant playing now, coloured
  by its place in the ladder like the web player's badge. `detailed` (Admin → Sessions)
  adds the ladder, switches, bandwidth and — with `encoder` — what the server encodes.
-->
<script lang="ts">
    import type { SessionAdaptive } from '$lib/schemas/session-adaptive.js';
    import type { ProxyEncoderInfo } from '$lib/schemas/livetv.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        adaptiveBadgeText,
        adaptiveStats,
        adaptiveTierClass,
        adaptiveTooltip,
        formatAbrTime,
        rungIdName,
        variantLabel,
    } from './adaptive-display.js';

    interface Props {
        adaptive: SessionAdaptive;
        detailed?: boolean;
        /** The channel's adaptive encoder group (admin, Live TV only). */
        encoder?: ProxyEncoderInfo | null;
        /** Health label for the encoder ("Healthy"), from the admin panel. */
        encoderHealthLabel?: string;
    }
    let { adaptive, detailed = false, encoder = null, encoderHealthLabel }: Props = $props();

    const encodedOutputs = $derived(encoder ? new Set(encoder.outputs) : null);
    const stats = $derived(adaptiveStats(adaptive));
</script>

<span
    class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-bold whitespace-nowrap {adaptiveTierClass(
        adaptive.tier,
    )}"
    title={adaptiveTooltip(adaptive)}
    data-testid="adaptive-badge"
    data-tier={adaptive.tier ?? 'unknown'}>
    {adaptiveBadgeText(adaptive)}
</span>

{#if detailed}
    <div class="mt-1.5 space-y-1 text-[11px] text-surface-300" data-testid="adaptive-details">
        <div class="flex flex-wrap items-center gap-1">
            <span class="text-surface-400 mr-0.5">{m.sessions_abr_ladder()}</span>
            {#each adaptive.ladder as variant (variant.id)}
                {@const playing = adaptive.current?.id === variant.id}
                {@const notEncoded = encodedOutputs !== null && !encodedOutputs.has(variant.id)}
                <span
                    class="px-1.5 py-0.5 rounded border {playing
                        ? 'border-teal-500/60 bg-teal-900/40 text-teal-200'
                        : 'border-surface-600/50 bg-surface-800/50'} {notEncoded
                        ? 'opacity-50 line-through'
                        : ''}"
                    title={notEncoded ? m.sessions_abr_not_encoded() : undefined}
                    data-variant={variant.id}
                    data-playing={playing ? 'true' : undefined}>
                    {variantLabel(variant)}
                </span>
            {/each}
        </div>
        <div class="flex flex-wrap gap-x-2 gap-y-0.5 text-surface-400">
            <span
                >{adaptive.source === 'server'
                    ? m.sessions_abr_source_server()
                    : m.sessions_abr_source_client()}</span>
            {#if adaptive.currentSince}
                <span>{m.sessions_abr_since({ time: formatAbrTime(adaptive.currentSince) })}</span>
            {/if}
            {#each stats as stat (stat)}
                <span>{stat}</span>
            {/each}
        </div>
        {#if adaptive.recentSwitches && adaptive.recentSwitches.length > 0}
            <div class="flex flex-wrap items-center gap-x-2 text-surface-400">
                <span>{m.sessions_abr_recent()}</span>
                {#each adaptive.recentSwitches as change, index (index)}
                    <span class="text-surface-300"
                        >{rungIdName(adaptive, change.from)} → {rungIdName(adaptive, change.to)}
                        <span class="text-surface-500">{formatAbrTime(change.at)}</span></span>
                {/each}
            </div>
        {/if}
        {#if encoder}
            <div class="text-surface-400" data-testid="adaptive-encoder">
                {m.sessions_abr_encoding()}:
                <span class="text-surface-300">{encoder.outputs.join(', ')}</span>
                {#if encoderHealthLabel}· {encoderHealthLabel}{/if}
                · {m.admin_sessions_encoder_slots({ count: String(encoder.reservedOutputs) })}
                · {m.admin_sessions_encoder_viewers({ count: String(encoder.viewers) })}
            </div>
        {/if}
    </div>
{/if}
