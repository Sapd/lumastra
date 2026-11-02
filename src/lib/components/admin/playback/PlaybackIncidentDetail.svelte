<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Renders one playback incident's forensic detail: fields, timeline, and any
  correlated transcode_failure_events rows. Redaction goes entirely through
  `formatIncidentReport` in $lib/shared — never re-implemented here.

  Unlike TranscodeFailureDetail.svelte, there is no `redactionUnavailable`
  guard on "Copy for GitHub" here — incident timelines carry stream URLs, not
  filesystem paths, so an empty `libraryRoots` doesn't disable redaction the
  way it does for the transcode report (see the plan's Global Constraints).
-->
<script lang="ts">
    import { Icon, ArrowTopRightOnSquare, ClipboardDocument } from 'svelte-hero-icons';
    import { formatIncidentReport } from '$lib/shared/playback-incident-report.js';
    import type { RedactOptions } from '$lib/shared/transcode-failure-report.js';
    import type {
        PlaybackIncidentDetail as PlaybackIncidentDetailType,
        CorrelatedTranscodeFailure,
        DeliveryWindow,
    } from '$lib/schemas/api-playback-incidents.js';
    import type { SpeedTestResultResponse } from '$lib/schemas/api-network-responses.js';
    import { formatMbit as mbit, formatSpeedTestMode } from '$lib/utils/admin/playback-formatters';
    import { toasts } from '$lib/stores/toast.store';
    import { openMediaModalFromUrl } from '$lib/utils/modal-utils';
    import { resolve } from '$lib/paths';

    interface Props {
        incident: PlaybackIncidentDetailType;
        correlatedTranscodeFailures: CorrelatedTranscodeFailure[];
        roots: RedactOptions;
        /**
         * Receiver-timed delivery windows for this incident's play session,
         * oldest first. Shown raw rather than averaged: a link that is usually
         * ample and periodically collapses is a SHAPE, and an average erases it.
         */
        deliveryWindows?: DeliveryWindow[];
        /** Speed tests this user ran in the last 7 days, newest first. */
        speedTests?: SpeedTestResultResponse[];
    }

    let {
        incident,
        correlatedTranscodeFailures,
        roots,
        deliveryWindows = [],
        speedTests = [],
    }: Props = $props();

    async function copy(mode: 'github' | 'raw'): Promise<void> {
        const body = formatIncidentReport(incident, mode, roots, correlatedTranscodeFailures);
        try {
            await navigator.clipboard.writeText(body);
        } catch {
            toasts.error('Copy failed — clipboard access was denied');
            return;
        }
        toasts.success(mode === 'github' ? 'Copied (redacted)' : 'Copied (raw)');
    }

    /** A millisecond figure the reporting client may simply not have sent. */
    function millis(value: number | null): string {
        return value === null ? '—' : `${Math.round(value)} ms`;
    }

    function count(value: number | null): string {
        return value === null ? '—' : String(value);
    }

    function seconds(value: number | null): string {
        return value === null ? '—' : `${value.toFixed(1)} s`;
    }

    function formatClock(iso: string): string {
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
    }

    function formatTimestamp(iso: string): string {
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
    }

    function openMediaModal(): void {
        if (!incident.mediaId) return;
        openMediaModalFromUrl({ internal: incident.mediaId }, 'movie').catch(() => {
            toasts.error('This media item is no longer available');
        });
    }

    function explainServerDiagnostic(code: string | null): string | null {
        switch (code) {
            case 'session-expired':
                return 'The stream session metadata was no longer available when the player requested a segment. Most commonly this is the server idle-reaping a fully-produced transcode job after several minutes with no segment requests or heartbeats (e.g. the tab was paused and then backgrounded/minimized long enough for the browser to throttle its keepalive) — check FFMPEG_INACTIVITY_TIMEOUT_SECONDS if this is happening often. Less commonly: an admin-initiated stop, or a genuinely abandoned session.';
            case 'upstream-timeout':
                return 'The server restarted the stream, but the requested segment was not ready before the timeout.';
            case 'transcoder-start-failed':
                return 'The server could not start or restore the FFmpeg transcode job.';
            case 'source-unavailable':
                return 'The original media source could not be read.';
            case 'storage-read-failed':
                return 'The server could not read the stream output from storage.';
            case 'concurrency-limit':
                return 'The stream was rejected because the concurrent-transcode limit was reached.';
            case 'playback-method-not-allowed':
                return "The stream was rejected because the user's stream policy (allowed_play_methods) does not allow the play method the server would have used, e.g. a transcode.";
            default:
                return 'No local explanation is available for this server diagnostic code.';
        }
    }
</script>

<div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
        <button
            type="button"
            class="btn btn-sm variant-filled-primary inline-flex items-center gap-1"
            onclick={() => copy('github')}>
            <Icon src={ClipboardDocument} class="h-4 w-4" />
            <span>Copy for GitHub</span>
        </button>
        <button
            type="button"
            class="btn btn-sm variant-soft inline-flex items-center gap-1"
            onclick={() => copy('raw')}>
            <Icon src={ClipboardDocument} class="h-4 w-4" />
            <span>Copy raw</span>
        </button>
    </div>

    <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <span class="text-surface-400">Trigger</span>
        <span class="badge-soft-cyan w-fit">{incident.triggerType}</span>
        <span class="text-surface-400">Incident at</span>
        <span>{formatTimestamp(incident.incidentAt)}</span>
        <span class="text-surface-400">Recorded by server</span>
        <span>{formatTimestamp(incident.serverRecordedAt)}</span>
        <span class="text-surface-400">User</span>
        <div>
            <span>{incident.username ?? incident.userId ?? 'Unknown'}</span>
            {#if incident.username && incident.userId}
                <code class="ml-2 text-xs text-surface-500">{incident.userId}</code>
            {/if}
        </div>
        <span class="text-surface-400">Device</span>
        <div>
            <span>{incident.deviceName ?? incident.deviceId ?? 'Unknown'}</span>
            {#if incident.deviceName && incident.deviceId}
                <code class="ml-2 break-all text-xs text-surface-500">{incident.deviceId}</code>
            {/if}
        </div>
        <span class="text-surface-400">Media</span>
        <div class="flex min-w-0 items-center gap-2">
            <span class="truncate">{incident.mediaTitle ?? incident.mediaId ?? 'Unknown'}</span>
            {#if incident.mediaId}
                <button
                    type="button"
                    class="shrink-0 text-xs text-primary-400 hover:underline"
                    onclick={openMediaModal}>Open</button>
                <a
                    href={resolve(`/admin/library/media/${incident.mediaId}`)}
                    class="shrink-0 text-surface-400 hover:text-surface-100"
                    title="Open in admin media">
                    <Icon src={ArrowTopRightOnSquare} class="h-3.5 w-3.5" />
                </a>
            {/if}
        </div>
        {#if incident.errorType}
            <span class="text-surface-400">Error type</span>
            <span>{incident.errorType}</span>
        {/if}
        {#if incident.stage}
            <span class="text-surface-400">Stage</span>
            <span>{incident.stage}</span>
        {/if}
        {#if incident.httpStatus !== null}
            <span class="text-surface-400">HTTP status</span>
            <span>{incident.httpStatus}</span>
        {/if}
        {#if incident.serverDiagnosticCode}
            <span class="text-surface-400">Server diagnostic code</span>
            <div>
                <code>{incident.serverDiagnosticCode}</code>
                {#if explainServerDiagnostic(incident.serverDiagnosticCode)}
                    <p class="mt-1 text-xs text-surface-400">
                        {explainServerDiagnostic(incident.serverDiagnosticCode)}
                    </p>
                {/if}
            </div>
        {/if}
        {#if incident.reconnectCause}
            <span class="text-surface-400">Reconnect cause</span>
            <span>{incident.reconnectCause}</span>
        {/if}
        <span class="text-surface-400">Resolved</span>
        <span>{incident.resolvedAt ? `yes, ${formatTimestamp(incident.resolvedAt)}` : 'no'}</span>
        <span class="text-surface-400">Attempt ID</span>
        <code class="break-all text-xs">{incident.attemptId}</code>
        <span class="text-surface-400">Play session ID</span>
        <code class="break-all text-xs">{incident.playSessionId || 'Not available'}</code>
    </div>

    {#if incident.message}
        <p class="text-sm text-surface-200">{incident.message}</p>
    {/if}

    {#if incident.clientInfo}
        <details class="rounded border border-surface-700/50 bg-surface-800/30 p-2 text-xs">
            <summary class="cursor-pointer text-surface-300">Client context</summary>
            <pre
                class="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-surface-300">{JSON.stringify(
                    incident.clientInfo,
                    null,
                    2,
                )}</pre>
        </details>
    {/if}

    <div>
        <h4 class="mb-1 text-xs uppercase text-surface-400">Timeline</h4>
        {#if incident.timeline.length === 0}
            <p class="text-sm italic text-surface-500">No timeline recorded for this incident.</p>
        {:else}
            <ol class="space-y-1">
                {#each incident.timeline as entry, i (i)}
                    <li class="rounded border border-surface-700/50 bg-surface-800/30 p-2 text-xs">
                        <pre
                            class="whitespace-pre-wrap font-mono text-[11px] text-surface-300">{JSON.stringify(
                                entry,
                            )}</pre>
                    </li>
                {/each}
            </ol>
        {/if}
    </div>

    {#if correlatedTranscodeFailures.length > 0}
        <div>
            <h4 class="mb-1 text-xs uppercase text-surface-400">Related transcode failures</h4>
            <ol class="space-y-1">
                {#each correlatedTranscodeFailures as failure, i (i)}
                    <li class="rounded border border-surface-700/50 bg-surface-800/30 p-2 text-xs">
                        <span class="font-mono text-surface-200">{failure.category}</span>
                        <span class="ml-2 text-surface-400"
                            >{formatTimestamp(failure.occurredAt)}</span>
                        {#if failure.summary}
                            <p class="mt-1 text-surface-300">{failure.summary}</p>
                        {/if}
                    </li>
                {/each}
            </ol>
        </div>
    {/if}

    {#if deliveryWindows.length > 0}
        <div>
            <h4 class="mb-1 text-xs uppercase text-surface-400">Delivery windows (client-timed)</h4>
            <p class="mb-2 text-xs text-surface-500">
                What the player actually received, as it received it. A row whose Mbit/s is fine but
                whose wall max is large means one segment arrived late, not that the line is slow.
            </p>
            <div class="overflow-x-auto">
                <table class="w-full text-left text-xs tabular-nums">
                    <thead class="text-surface-400">
                        <tr>
                            <th class="px-2 py-1 font-normal">Time</th>
                            <th class="px-2 py-1 font-normal">Mbit/s</th>
                            <th
                                class="px-2 py-1 font-normal"
                                title="Slowest single segment in the window — a collapse one segment wide that the window average hides"
                                >Slowest seg</th>
                            <th class="px-2 py-1 font-normal">Segments</th>
                            <th class="px-2 py-1 font-normal">Wall max</th>
                            <th class="px-2 py-1 font-normal">TTFB max</th>
                            <th class="px-2 py-1 font-normal">Overdue</th>
                            <th class="px-2 py-1 font-normal">Buffer</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each deliveryWindows as win, i (i)}
                            <tr class="border-t border-surface-700/30">
                                <td class="px-2 py-1">{formatClock(win.recordedAt)}</td>
                                <td class="px-2 py-1">{mbit(win.throughputBps)}</td>
                                <td class="px-2 py-1">{mbit(win.minSegBps)}</td>
                                <td class="px-2 py-1">{count(win.segments)}</td>
                                <td class="px-2 py-1">{millis(win.wallMaxMs)}</td>
                                <td class="px-2 py-1">{millis(win.ttfbMaxMs)}</td>
                                <td class="px-2 py-1">{count(win.overdue)}</td>
                                <td class="px-2 py-1">{seconds(win.bufferAheadSec)}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        </div>
    {/if}

    {#if speedTests.length > 0}
        <div>
            <h4 class="mb-1 text-xs uppercase text-surface-400">Recent speed tests</h4>
            <p class="mb-2 text-xs text-surface-500">
                This user's own measurements from the last 7 days — the one number that separates a
                bad line from bad delivery.
            </p>
            <ol class="space-y-1">
                {#each speedTests as speedTest (speedTest.id)}
                    <li
                        class="rounded border border-surface-700/50 bg-surface-800/30 p-2 text-xs tabular-nums">
                        <span
                            class="rounded bg-surface-700/60 px-1 text-surface-300"
                            title="Which profile produced this row">
                            {formatSpeedTestMode(speedTest.mode)}
                        </span>
                        <span class="ml-2 text-surface-200"
                            >{mbit(speedTest.throughputBps)} Mbit/s</span>
                        <span class="ml-2 text-surface-400"
                            >first byte {Math.round(speedTest.ttfbMs)} ms</span>
                        {#if speedTest.mode === 'cadence'}
                            <!-- A cadence run records no buckets, so there is no
                                 slowest quarter-second and no stall total: the
                                 worst SEGMENT is the comparable figure. -->
                            <span class="ml-2 text-surface-400"
                                >worst segment {mbit(speedTest.minRequestBps)} Mbit/s</span>
                            <span class="ml-2 text-surface-400"
                                >worst TTFB {speedTest.maxTtfbMs === null
                                    ? '—'
                                    : Math.round(speedTest.maxTtfbMs)} ms</span>
                        {:else}
                            <span class="ml-2 text-surface-400"
                                >slowest ¼ s {mbit(speedTest.minBucketBps)} Mbit/s</span>
                            <span class="ml-2 text-surface-400"
                                >stalled {Math.round(speedTest.stallMs)} ms</span>
                        {/if}
                        {#if speedTest.aborted}
                            <span class="ml-2 text-warning-400">gave up early</span>
                        {/if}
                        <span class="ml-2 text-surface-500"
                            >{formatTimestamp(speedTest.createdAt)}</span>
                    </li>
                {/each}
            </ol>
        </div>
    {/if}
</div>
