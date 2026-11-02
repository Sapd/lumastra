<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  RunLogStream — the live-tailing SSE log viewer, with no surrounding chrome.

  Owns the EventSource lifecycle, replay/reconnect handling, the copy button,
  and the scrollable <pre>. It is embedded two ways:
    • inline inside RunDetailPanel (the "View logs" toggle), and
    • inside RunLogDrawer, which adds the slide-over dialog chrome.

  Keep this presentation-only and self-contained so both hosts share one
  streaming implementation.
-->

<script lang="ts">
    // Display: local time and shortened ids (full values in each line's
    // tooltip; Copy keeps the raw ISO + full text).
    import { formatLogTime, shortenUuids } from './run-labels.js';
    import { tick } from 'svelte';
    import { RunLogEntrySchema, type RunLogEntry } from '$lib/schemas/run.schema.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { apiUrl } from '$lib/shared/api-urls.js';

    interface Props {
        runId: string;
        /** Extra classes for the scrollable log body. Drawer passes `flex-1`;
         *  inline use gets a bounded, self-scrolling height by default. */
        bodyClass?: string;
        /** Override the "no entries" message (e.g. a host distinguishing a
         *  still-running run from a finished one). Defaults to the original
         *  generic copy when omitted. */
        emptyMessage?: string;
    }

    let { runId, bodyClass = 'max-h-80', emptyMessage = 'No log entries yet.' }: Props = $props();

    let entries: RunLogEntry[] = $state([]);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let copied = $state(false);
    let copiedTimer: ReturnType<typeof setTimeout> | null = null;
    let autoFollow = $state(true);
    let logBody = $state<HTMLDivElement | null>(null);

    const MAX_ENTRIES = 5000;
    const MAX_RECONNECT_ATTEMPTS = 10;
    // Belt-and-suspenders: if neither onopen nor a first frame arrives within
    // this window, stop showing "Connecting…" and fall through to the normal
    // empty/error states. The server now flushes a preamble so onopen fires
    // promptly, but this guarantees the UI can never wedge on "Connecting…".
    const CONNECT_FALLBACK_MS = 8000;

    let eventSource: EventSource | null = null;
    let lastId = '0';
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectBackoff = 1000;
    let reconnectAttempts = 0;
    let reconnectExhausted = $state(false);
    let connectFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    let ariaAnnouncement = $state('');
    let ariaDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Separate status channel for connection-state announcements
    // (connected / reconnecting / failed). Keeping it distinct from the
    // entry-count region avoids interleaving log-volume noise with the
    // operationally-relevant connectivity signal.
    let connectionStatus = $state('');

    function announceEntryCount(count: number): void {
        if (ariaDebounceTimer) clearTimeout(ariaDebounceTimer);
        ariaDebounceTimer = setTimeout(() => {
            ariaAnnouncement = `${count} log entries`;
        }, 2000);
    }

    function appendEntry(raw: unknown): void {
        const parsed = RunLogEntrySchema.safeParse(raw);
        if (parsed.success) {
            const next = [...entries, parsed.data];
            entries = next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
            announceEntryCount(entries.length);
        }
    }

    /** Keep a live log pinned to the newest entry only when the operator asks for it. */
    async function scrollToLatest(): Promise<void> {
        if (!autoFollow || !logBody) return;
        await tick();
        if (autoFollow && logBody) logBody.scrollTop = logBody.scrollHeight;
    }

    function handleLogScroll(): void {
        if (!logBody) return;
        // Scrolling away from the tail intentionally pauses following; moving
        // back to the tail re-enables it without needing an extra click.
        autoFollow = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight <= 24;
    }

    function handleAutoFollowChange(event: Event): void {
        autoFollow = (event.currentTarget as HTMLInputElement).checked;
        if (autoFollow) void scrollToLatest();
    }

    $effect(() => {
        entries.length;
        if (autoFollow) void scrollToLatest();
    });

    function clearConnectFallback(): void {
        if (connectFallbackTimer) {
            clearTimeout(connectFallbackTimer);
            connectFallbackTimer = null;
        }
    }

    function connectSSE(id: string): void {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        const isReconnect = lastId !== '0';
        if (!isReconnect) {
            entries = [];
            loading = true;
            loadError = null;
        }

        clearConnectFallback();
        connectFallbackTimer = setTimeout(() => {
            connectFallbackTimer = null;
            // Only matters if we're still in the very first "Connecting…" state.
            if (loading && entries.length === 0) loading = false;
        }, CONNECT_FALLBACK_MS);

        const logsPath = apiUrl('internal', `/runs/${encodeURIComponent(id)}/logs`);
        const url = lastId !== '0' ? `${logsPath}?since=${encodeURIComponent(lastId)}` : logsPath;
        eventSource = new EventSource(url);

        eventSource.onmessage = (event: MessageEvent<string>) => {
            if (event.lastEventId) lastId = event.lastEventId;
            reconnectBackoff = 1000;
            clearConnectFallback();
            try {
                appendEntry(JSON.parse(event.data));
            } catch {
                /* malformed entry */
            }
            loading = false;
        };

        eventSource.onopen = () => {
            reconnectBackoff = 1000;
            clearConnectFallback();
            // Only announce "Log stream connected" on a real reconnect — the
            // initial connect doesn't need a verbal announcement.
            if (reconnectAttempts > 0) connectionStatus = 'Reconnected to live logs.';
            reconnectAttempts = 0;
            // The amber "reconnecting…" banner described a past drop; once the
            // stream is open again it would only mislead.
            loadError = null;
            loading = false;
        };

        eventSource.onerror = () => {
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            if (destroyed) return;
            loading = false;

            reconnectAttempts++;
            if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                reconnectExhausted = true;
                loadError = 'Lost the live log connection and stopped trying to reconnect.';
                connectionStatus = 'Live logs disconnected — gave up reconnecting.';
                return;
            }

            if (!loadError) loadError = 'Lost the live log connection — reconnecting…';
            connectionStatus = `Reconnecting to live logs (attempt ${reconnectAttempts} of ${MAX_RECONNECT_ATTEMPTS}).`;
            const backoff = reconnectBackoff;
            reconnectBackoff = Math.min(reconnectBackoff * 2, 30_000);
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (!destroyed) connectSSE(id);
            }, backoff);
        };
    }

    function manualRetry(): void {
        reconnectAttempts = 0;
        reconnectBackoff = 1000;
        reconnectExhausted = false;
        loadError = null;
        connectionStatus = 'Reconnecting to live logs.';
        if (ariaDebounceTimer) {
            clearTimeout(ariaDebounceTimer);
            ariaDebounceTimer = null;
        }
        connectSSE(runId);
    }

    $effect(() => {
        destroyed = false;
        lastId = '0';
        reconnectAttempts = 0;
        reconnectBackoff = 1000;
        reconnectExhausted = false;
        connectSSE(runId);
        return () => {
            destroyed = true;
            clearConnectFallback();
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            if (copiedTimer) {
                clearTimeout(copiedTimer);
                copiedTimer = null;
            }
            if (ariaDebounceTimer) {
                clearTimeout(ariaDebounceTimer);
                ariaDebounceTimer = null;
            }
        };
    });

    async function copyLogs(): Promise<void> {
        try {
            const text = entries
                .map((e) => `[${new Date(e.ts).toISOString()}] ${e.msg}`)
                .join('\n');
            await navigator.clipboard.writeText(text);
            copied = true;
            if (copiedTimer) clearTimeout(copiedTimer);
            copiedTimer = setTimeout(() => {
                copied = false;
                copiedTimer = null;
            }, 2000);
        } catch (err) {
            toasts.error(`Copy failed: ${err instanceof Error ? err.message : 'Clipboard denied'}`);
        }
    }

    function levelClass(level: RunLogEntry['level']): string {
        if (level === 'error') return 'text-red-400';
        if (level === 'warn') return 'text-amber-400';
        if (level === 'debug') return 'text-surface-500';
        return 'text-surface-400';
    }
</script>

<div class="flex min-h-0 flex-col">
    <!-- Toolbar stays visible before the first log line so the follow setting
         is explicit rather than appearing only after streaming has begun. -->
    <div class="mb-2 flex items-center justify-between gap-3">
        <span class="text-xs text-surface-500 tabular-nums">{entries.length} entries</span>
        <div class="flex items-center gap-3">
            <label class="flex cursor-pointer items-center gap-1.5 text-xs text-surface-400">
                <input
                    type="checkbox"
                    checked={autoFollow}
                    onchange={handleAutoFollowChange}
                    class="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500/30" />
                Auto-follow
            </label>
            <button
                type="button"
                class="text-xs text-blue-400 hover:text-blue-300"
                disabled={entries.length === 0}
                onclick={copyLogs}>
                {copied ? 'Copied!' : 'Copy'}
            </button>
        </div>
    </div>

    <!--
        Dedicated polite status region for connection-state announcements
        (initial connect / reconnect attempts / exhaustion / manual retry).
    -->
    <div role="status" aria-live="polite" aria-atomic="true" class="sr-only">
        {connectionStatus}
    </div>

    <div
        bind:this={logBody}
        class="{bodyClass} min-h-0 overflow-y-auto rounded bg-surface-900/40"
        onscroll={handleLogScroll}>
        {#if loading && entries.length === 0}
            <p class="p-3 text-sm text-surface-500">Connecting…</p>
        {:else if reconnectExhausted && entries.length === 0}
            <div
                class="m-3 rounded border border-red-700/30 bg-red-900/20 p-3 text-sm text-red-300 space-y-2">
                <p>{loadError}</p>
                <button type="button" class="text-xs text-red-200 underline" onclick={manualRetry}>
                    Retry connection
                </button>
            </div>
        {:else if loadError && entries.length === 0}
            <div
                class="m-3 rounded border border-red-700/30 bg-red-900/20 p-3 text-sm text-red-300">
                {loadError}
                {#if reconnectExhausted}
                    <button
                        type="button"
                        class="ml-3 text-xs text-red-200 underline"
                        onclick={manualRetry}>
                        Retry
                    </button>
                {/if}
            </div>
        {:else if entries.length === 0}
            <p class="p-3 text-sm text-surface-500 italic">{emptyMessage}</p>
        {:else}
            {#if reconnectExhausted}
                <div
                    class="m-3 flex items-center gap-2 rounded border border-red-700/30 bg-red-900/20 px-3 py-2 text-xs text-red-300">
                    <span>Live logs disconnected — gave up reconnecting.</span>
                    <button
                        type="button"
                        class="ml-auto text-red-200 underline"
                        onclick={manualRetry}>
                        Retry
                    </button>
                </div>
            {:else if loadError}
                <div
                    class="m-3 rounded border border-amber-700/30 bg-amber-900/20 px-3 py-2 text-xs text-amber-300">
                    {loadError}
                </div>
            {/if}
            <!--
                The status region carries periodic "N entries" announcements.
                The <pre> below explicitly opts out of live updates: with thousands
                of entries it would otherwise flood screen readers on every append.
            -->
            <div aria-live="polite" aria-atomic="true" class="sr-only">
                {ariaAnnouncement}
            </div>
            <pre
                class="p-3 font-mono text-xs text-surface-400 whitespace-pre-wrap"
                aria-label="Log output"
                aria-live="off">{#each entries as entry (`${entry.seq ?? ''}-${entry.ts}`)}<span
                        class={levelClass(entry.level)}
                        title={`${new Date(entry.ts).toISOString()} ${entry.msg}`}
                        >[{formatLogTime(entry.ts)}] {shortenUuids(entry.msg)}
</span>{/each}</pre>
        {/if}
    </div>
</div>
