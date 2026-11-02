<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { HeartbeatView } from '$lib/schemas/task-system-observability.schema.js';
    import TermTooltip from '$lib/components/admin/glossary/TermTooltip.svelte';
    import { GLOSSARY } from '$lib/components/admin/glossary/glossary.js';

    interface Props {
        subsystems: HeartbeatView[];
    }

    const { subsystems }: Props = $props();

    /**
     * Subsystem heartbeat names line up with glossary keys
     * (reconciler, stage-sweep, pending-write-drain, event-dispatcher,
     * scheduler). Returns the matching glossary key, or undefined when no
     * plain-language definition exists for that name.
     */
    function glossaryKeyFor(name: string): string | undefined {
        return name in GLOSSARY ? name : undefined;
    }

    /**
     * Operator-facing heading for a heartbeat. The raw name (`reconciler`,
     * `stage-sweep`, …) is still the glossary lookup key and the identity the
     * server sends — only the DISPLAYED heading changes here, to the glossary
     * entry's plain-language `term`, so the tooltip's bold headline never
     * disagrees with the heading it hangs off. Falls back to the raw name for
     * any heartbeat that has no glossary entry yet.
     */
    function displayName(name: string): string {
        return GLOSSARY[name]?.term() ?? name;
    }

    function formatAge(ms: number | undefined): string {
        if (ms === undefined) return '';
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s ago`;
        const m = Math.round(s / 60);
        if (m < 60) return `${m}m ago`;
        return `${Math.round(m / 60)}h ago`;
    }

    function num(detail: Record<string, unknown> | undefined, key: string): number | undefined {
        const v = detail?.[key];
        return typeof v === 'number' ? v : undefined;
    }

    /** One-line summary derived from a heartbeat's typed `detail`. */
    function describeSubsystem(s: HeartbeatView): string {
        if (!s.alive) return 'not reporting in';
        const d = s.detail;
        switch (s.name) {
            case 'reconciler': {
                const orphans = num(d, 'orphansReclaimed') ?? 0;
                const wedged = num(d, 'wedgedStageRowsReclaimed') ?? 0;
                return `recovered ${orphans} stuck job(s) · ${wedged} freed up`;
            }
            case 'stage-sweep': {
                const enq = num(d, 'enqueued') ?? 0;
                const capped = d?.hitGlobalEnqueueCap === true;
                return `started ${enq} · ${capped ? 'at busy limit' : 'within limit'}`;
            }
            case 'pending-write-drain': {
                const depth = num(d, 'depth') ?? 0;
                return `${depth} waiting to save`;
            }
            case 'event-dispatcher': {
                const drained = num(d, 'drained') ?? 0;
                const dead = num(d, 'deadLettered') ?? 0;
                return `${drained} processed · ${dead} could not be delivered`;
            }
            case 'scheduler': {
                const fired = num(d, 'firedCount') ?? 0;
                return `${fired} started on schedule`;
            }
            default:
                return s.status ?? 'ok';
        }
    }

    function dotClass(s: HeartbeatView): string {
        if (!s.alive) return 'bg-red-400';
        return s.status === 'degraded' ? 'bg-amber-400' : 'bg-green-400';
    }
</script>

<section class="space-y-3">
    <h2 class="text-sm font-semibold text-surface-200">Background services</h2>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {#each subsystems as s (s.name)}
            <div class="card-bordered p-4 space-y-2">
                <div class="flex items-center gap-2">
                    <span class="inline-block h-3 w-3 rounded-full {dotClass(s)}" aria-hidden="true"
                    ></span>
                    <h3 class="text-sm font-semibold text-surface-200">
                        {#if glossaryKeyFor(s.name)}
                            <TermTooltip term={glossaryKeyFor(s.name) ?? ''}
                                >{displayName(s.name)}</TermTooltip>
                        {:else}
                            {displayName(s.name)}
                        {/if}
                    </h3>
                    {#if s.leaderGated}
                        <span
                            class="ml-auto rounded bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-400"
                            title="Runs on only one server at a time to avoid duplicate work">
                            single-server
                        </span>
                    {/if}
                </div>
                <p class="text-xs text-surface-400">{describeSubsystem(s)}</p>
                <p class="text-[11px] text-surface-500">
                    {#if s.alive}
                        {formatAge(s.ageMs)}{#if s.instanceId}
                            · {s.instanceId}{/if}
                    {:else}
                        <span class="text-red-400"
                            >not reporting in ({formatAge(s.ageMs) || 'never seen'})</span>
                    {/if}
                </p>
            </div>
        {/each}
    </div>
</section>
