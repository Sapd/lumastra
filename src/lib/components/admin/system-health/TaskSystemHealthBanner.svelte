<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { taxonomyBadge } from '$lib/utils/health-taxonomy.js';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import { GLOSSARY } from '$lib/components/admin/glossary/glossary.js';
    import type { HealthVerdict, HealthReason } from '$lib/schemas/task-system-health.schema.js';
    import type { InvariantDetailLink } from '$lib/schemas/health-invariants.schema.js';

    interface Props {
        health: HealthVerdict;
    }

    const { health }: Props = $props();

    const badge = $derived(taxonomyBadge(health.status));

    function reasonIcon(r: HealthReason): string {
        return r.severity === 'error' ? '✕' : '!';
    }

    function reasonIconClass(r: HealthReason): string {
        return r.severity === 'error' ? 'text-red-400' : 'text-amber-400';
    }

    function asOf(iso: string): string {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
    }

    function hasDetail(r: HealthReason): boolean {
        return r.detail !== undefined && Object.keys(r.detail).length > 0;
    }

    /**
     * Plain-language name for the part of the system a reason points at. The raw
     * codes (e.g. `reconciler`, `event-dispatcher`, `leader:embedding`) are
     * internal — operators should see a recognisable area name instead.
     * Sourced from the shared glossary (`GLOSSARY[name].term()`) so this label
     * always agrees with the one `SubsystemLivenessGrid` renders for the same
     * heartbeat name.
     */
    function subsystemLabel(name: string): string {
        const entry = GLOSSARY[name];
        if (entry) return entry.term();
        // Drop a single-server-coordination prefix and tidy remaining codes.
        const cleaned = name.replace(/^leader:/, '');
        const base = cleaned.replace(/[-_:]+/g, ' ').trim();
        return base ? base.charAt(0).toUpperCase() + base.slice(1) : name;
    }

    /** Pull the human-readable fields out of a reason's detail (when present). */
    function readable(r: HealthReason): {
        description?: string;
        remediation?: string;
        metric?: string;
        details?: InvariantDetailLink[];
    } {
        const d = r.detail ?? {};
        const out: {
            description?: string;
            remediation?: string;
            metric?: string;
            details?: InvariantDetailLink[];
        } = {};
        if (typeof d.description === 'string') out.description = d.description;
        if (typeof d.remediation === 'string') out.remediation = d.remediation;

        // Honest metric copy: the raw value plus what the two thresholds
        // actually mean, instead of "2604 (problem level: 10000)" — which
        // reads like the finding is already AT the red threshold.
        const value = typeof d.value === 'number' ? d.value : null;
        const amber = typeof d.thresholdAmber === 'number' ? d.thresholdAmber : null;
        const red = typeof d.thresholdRed === 'number' ? d.thresholdRed : null;
        if (value !== null && amber !== null && red !== null) {
            out.metric = m.admin_health_invariant_value_thresholds({
                value: value.toLocaleString(),
                amber: amber.toLocaleString(),
                red: red.toLocaleString(),
            });
        } else if (amber !== null && red !== null) {
            out.metric = m.admin_health_invariant_thresholds_only({
                amber: amber.toLocaleString(),
                red: red.toLocaleString(),
            });
        } else if (value !== null) {
            out.metric = value.toLocaleString();
        }

        if (Array.isArray(d.details)) out.details = d.details as InvariantDetailLink[];
        return out;
    }
</script>

<section
    class="rounded-lg border border-surface-700/60 bg-surface-900/60 p-4 space-y-3"
    aria-label="Background jobs health status">
    <div class="flex items-center gap-3">
        <span class="inline-block h-3 w-3 rounded-full {badge.dotClass}" aria-hidden="true"></span>
        <h2 class="text-base font-semibold text-surface-100">Task System</h2>
        <span class="rounded px-2 py-0.5 text-xs font-semibold {badge.pillClass}">
            {badge.label}
        </span>
        <span class="ml-auto text-[11px] text-surface-500">as of {asOf(health.generatedAt)}</span>
    </div>

    {#if health.reasons.length > 0}
        <ul class="space-y-1.5">
            {#each health.reasons as reason, i (reason.code + ':' + reason.subsystem + ':' + i)}
                {@const r = readable(reason)}
                <li class="text-xs">
                    <div class="flex items-start gap-2">
                        <span class="font-bold {reasonIconClass(reason)}" aria-hidden="true">
                            {reasonIcon(reason)}
                        </span>
                        <span class="flex-1 text-surface-200">{reason.summary}</span>
                        <span
                            class="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-surface-400">
                            {subsystemLabel(reason.subsystem)}
                        </span>
                    </div>
                    {#if r.description || r.remediation || r.metric || (r.details && r.details.length > 0)}
                        <div class="ml-6 mt-1 space-y-1 text-[11px]">
                            {#if r.description}
                                <p class="text-surface-400">{r.description}</p>
                            {/if}
                            {#if r.metric}
                                <p class="text-surface-400">
                                    {m.admin_ops_health_current()}
                                    <span class="text-surface-200 tabular-nums">{r.metric}</span>
                                </p>
                            {/if}
                            <!-- Action links (which specific task is affected) —
                                 rendered BEFORE the remediation prose so the
                                 operator hits a deep link before general advice. -->
                            {#if r.details && r.details.length > 0}
                                <div class="flex flex-wrap gap-1.5">
                                    {#each r.details as d (d.href ?? `${d.label}:${d.sublabel ?? ''}`)}
                                        {#if d.href}
                                            <a
                                                href={resolve(d.href)}
                                                class="inline-flex items-center gap-1 rounded border border-surface-700/50 bg-surface-800/60 px-1.5 py-0.5 text-surface-300 hover:border-sky-700/50 hover:text-sky-300 transition-colors">
                                                {#if d.count !== undefined}
                                                    <span class="font-mono tabular-nums"
                                                        >{d.count.toLocaleString()}</span>
                                                {/if}
                                                <span>{d.label}</span>
                                                <span class="font-medium text-sky-400"
                                                    >{m.admin_health_invariant_open()}</span>
                                            </a>
                                        {:else}
                                            <span
                                                class="inline-flex items-center gap-1 rounded border border-surface-700/50 bg-surface-800/40 px-1.5 py-0.5 text-surface-400">
                                                {#if d.count !== undefined}
                                                    <span class="font-mono tabular-nums"
                                                        >{d.count.toLocaleString()}</span>
                                                {/if}
                                                <span>{d.label}</span>
                                            </span>
                                        {/if}
                                    {/each}
                                </div>
                            {/if}
                            {#if r.remediation}
                                <p class="text-surface-300">
                                    <span class="text-surface-500">{m.admin_ops_health_fix()}</span>
                                    {r.remediation}
                                </p>
                            {/if}
                        </div>
                    {/if}
                    {#if hasDetail(reason)}
                        <details class="ml-6 mt-1 group">
                            <summary
                                class="cursor-pointer text-[11px] text-surface-500 hover:text-surface-300">
                                {m.admin_ops_health_raw_detail()}
                            </summary>
                            <pre
                                class="mt-1 overflow-x-auto rounded bg-surface-900 p-2 text-[11px] text-surface-300">{JSON.stringify(
                                    reason.detail,
                                    null,
                                    2,
                                )}</pre>
                        </details>
                    {/if}
                </li>
            {/each}
        </ul>
    {:else}
        <p class="text-xs text-surface-400">
            Background workers, scheduled jobs, and data checks are all running normally.
        </p>
    {/if}
</section>
