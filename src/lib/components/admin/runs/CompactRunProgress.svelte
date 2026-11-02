<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { RunStage } from '$lib/schemas/run.schema.js';

    interface Props {
        stages: RunStage[];
    }

    let { stages }: Props = $props();

    let activeStage = $derived(stages.find((s) => s.state === 'active') ?? null);

    let label = $derived.by((): string | null => {
        if (!activeStage) return null;
        const processed = activeStage.processed ?? null;
        const total = activeStage.total ?? null;
        const parts: string[] = [activeStage.label];
        if (processed !== null && total !== null && total > 0) {
            parts.push(`${processed.toLocaleString()}/${total.toLocaleString()}`);
        }
        const etaMs = activeStage.etaMs;
        if (etaMs !== undefined && Number.isFinite(etaMs) && etaMs >= 0) {
            const secs = Math.round(etaMs / 1000);
            if (secs < 60) {
                parts.push(`~${secs}s`);
            } else {
                parts.push(`~${Math.round(secs / 60)}m`);
            }
        }
        return parts.join(' · ');
    });
</script>

{#if label}
    <span class="text-[11px] text-green-400 tabular-nums truncate">{label}</span>
{/if}
