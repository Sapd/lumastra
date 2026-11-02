<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import {
        Icon,
        CheckCircle,
        ExclamationTriangle,
        InformationCircle,
        XCircle,
        QuestionMarkCircle,
    } from 'svelte-hero-icons';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';

    interface Props {
        status: 'healthy' | 'notice' | 'warning' | 'mismatch' | 'unknown';
        tooltip?: string;
    }

    let { status, tooltip }: Props = $props();

    const config = $derived({
        healthy: {
            icon: CheckCircle,
            color: 'text-green-400 bg-green-400/10',
            label: m.media_plain_coverage_complete(),
        },
        notice: {
            icon: InformationCircle,
            color: 'text-blue-400 bg-blue-400/10',
            label: m.media_plain_notice(),
        },
        warning: {
            icon: ExclamationTriangle,
            color: 'text-yellow-400 bg-yellow-400/10',
            label: m.media_plain_warning(),
        },
        mismatch: {
            icon: XCircle,
            color: 'text-red-400 bg-red-400/10',
            label: m.media_health_status_mismatch(),
        },
        unknown: {
            icon: QuestionMarkCircle,
            color: 'text-surface-400 bg-surface-400/10',
            label: m.media_plain_unknown(),
        },
    });

    let cfg = $derived(config[status]);
</script>

{#if tooltip}
    <Tooltip text={tooltip} position="bottom">
        <span
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium {cfg.color}">
            <Icon src={cfg.icon} class="w-3.5 h-3.5" />
            {cfg.label}
        </span>
    </Tooltip>
{:else}
    <span
        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium {cfg.color}">
        <Icon src={cfg.icon} class="w-3.5 h-3.5" />
        {cfg.label}
    </span>
{/if}
