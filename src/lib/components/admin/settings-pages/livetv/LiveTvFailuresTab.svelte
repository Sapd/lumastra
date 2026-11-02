<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Failures tab for Settings → Live TV: persisted stream failures with a
  copy-pasteable, redacted GitHub report per incident.

  All redaction goes through `formatLiveTvFailureReport` in $lib/shared — never
  re-implemented here — so the same code path the tests exercise is the one behind
  these buttons. Logic in a .svelte file is invisible to both vitest and tsgo, so a
  redaction regression written here would ship green.
-->
<script lang="ts">
    import { Icon, ClipboardDocument, Signal } from 'svelte-hero-icons';
    import { AdminPageHeader } from '$lib/components/admin';
    import {
        formatLiveTvFailureReport,
        type LiveTvFailureReportInput,
    } from '$lib/shared/livetv-failure-report.js';
    import type {
        LiveTvFailuresTabData,
        LiveTvFailureIncident,
    } from '$lib/server/admin/livetv-failures-data';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';
    import { isLiveTvFailureReason } from '$lib/api/livetv-failure-problem.js';
    import { liveTvFailureReasonLabel } from '$lib/components/player/livetv-failure-presentation.js';

    /**
     * Typed-failure fields of an incident: set once the loader passes the event's
     * `reason`, `feed_id` and `upstream_status` columns through; absent on older rows.
     */
    interface TypedFailureFields {
        reason?: string | null;
        feedId?: string | null;
        feedName?: string | null;
        upstreamStatus?: number | null;
    }

    interface Props {
        data: Omit<LiveTvFailuresTabData, 'incidents'> & {
            incidents: (LiveTvFailureIncident & TypedFailureFields)[];
        };
    }

    let { data }: Props = $props();

    function toReportInput(incident: LiveTvFailureIncident): LiveTvFailureReportInput {
        return { ...incident, roots: data.roots };
    }

    function reasonLabel(incident: TypedFailureFields): string | null {
        return isLiveTvFailureReason(incident.reason)
            ? liveTvFailureReasonLabel(incident.reason)
            : null;
    }

    async function copy(incident: LiveTvFailureIncident, mode: 'github' | 'raw'): Promise<void> {
        try {
            await navigator.clipboard.writeText(
                formatLiveTvFailureReport(toReportInput(incident), mode),
            );
        } catch {
            // Insecure context or a denied permission: say so, never imply it copied.
            toasts.error('Could not copy to the clipboard');
            return;
        }
        toasts.success(mode === 'github' ? 'Copied (redacted)' : 'Copied (raw)');
    }

    /** First line of stderr that says something — the headline of the incident. */
    function headline(incident: LiveTvFailureIncident): string {
        const line = incident.stderrTail
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .at(-1);
        return line ?? 'no stderr captured';
    }

    function formatTimestamp(iso: string): string {
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
    }
</script>

<div class="space-y-6">
    <AdminPageHeader
        icon={Signal}
        title={m.admin_livetv_failures_title()}
        description={m.admin_livetv_failures_description()} />

    {#if data.loadError}
        <div
            role="alert"
            class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            Live TV failures could not be loaded: {data.loadError}
        </div>
    {:else if data.incidents.length === 0}
        <div class="rounded-lg bg-surface-800 p-8 text-center">
            <p class="text-surface-400">{m.admin_livetv_failures_empty()}</p>
        </div>
    {:else}
        <ul class="space-y-3">
            {#each data.incidents as incident (incident.id)}
                <li class="rounded border border-surface-700/50 bg-surface-800/30 p-3">
                    <div class="flex flex-wrap items-center gap-2 text-xs text-surface-400">
                        <span class="font-medium text-surface-100"
                            >{incident.channelName ?? incident.channelId}</span>
                        <span class="badge-soft-cyan">{incident.source}</span>
                        {#if reasonLabel(incident)}
                            <span class="badge-soft-orange" data-testid="failure-reason"
                                >{reasonLabel(incident)}</span>
                        {/if}
                        {#if incident.upstreamStatus}
                            <span>HTTP {incident.upstreamStatus}</span>
                        {/if}
                        {#if incident.feedName ?? incident.feedId}
                            <span data-testid="failure-feed"
                                >{m.admin_livetv_failures_feed({
                                    feed: incident.feedName ?? incident.feedId ?? '',
                                })}</span>
                        {/if}
                        <span>{incident.outcome}</span>
                        <span>exit {incident.exitCode ?? 'n/a'}</span>
                        {#if incident.signal}
                            <span>signal {incident.signal}</span>
                        {/if}
                        {#if incident.rungId}
                            <span>rung {incident.rungId}</span>
                        {/if}
                        <span class="ml-auto whitespace-nowrap"
                            >{formatTimestamp(incident.occurredAt)}</span>
                    </div>

                    <p class="mt-2 truncate font-mono text-xs text-surface-300">
                        {headline(incident)}
                    </p>

                    {#if incident.stderrTail}
                        <details class="mt-2 text-xs text-surface-400">
                            <summary class="cursor-pointer">stderr</summary>
                            <pre
                                class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-surface-300">{incident.stderrTail}</pre>
                        </details>
                    {/if}

                    <div class="mt-3 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            class="btn btn-sm variant-filled-primary inline-flex items-center gap-1"
                            onclick={() => void copy(incident, 'github')}>
                            <Icon src={ClipboardDocument} class="h-4 w-4" />
                            <span>{m.admin_livetv_failures_copy_github()}</span>
                        </button>
                        <button
                            type="button"
                            class="btn btn-sm variant-soft inline-flex items-center gap-1"
                            onclick={() => void copy(incident, 'raw')}>
                            <Icon src={ClipboardDocument} class="h-4 w-4" />
                            <span>{m.admin_livetv_failures_copy_raw()}</span>
                        </button>
                    </div>
                </li>
            {/each}
        </ul>
    {/if}
</div>
