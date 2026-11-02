<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Generic detail for non-incident client diagnostics (crash, hang, js_error,
  api_failures, log_bundle), with a readable summary for js_error and
  api_failures above the raw payload.
-->
<script lang="ts">
    import type { ClientDiagnosticDetail } from '$lib/schemas/client-diagnostics.js';
    import { apiUrl } from '$lib/shared/api-urls.js';
    import * as m from '$lib/paraglide/messages.js';
    import GithubReportDialog from './GithubReportDialog.svelte';

    let { diagnostic }: { diagnostic: ClientDiagnosticDetail } = $props();

    const logTail = $derived(
        (diagnostic.payload.logTail as { lines?: string[]; source?: string } | undefined) ?? null,
    );
    const payloadWithoutTail = $derived(
        Object.fromEntries(Object.entries(diagnostic.payload).filter(([k]) => k !== 'logTail')),
    );
    // Mirrors isJellyfinReportable on the server (the server is authoritative: 404/409).
    const reportable = $derived(
        diagnostic.kind === 'compat_incident' ||
            (diagnostic.kind === 'log_bundle' && diagnostic.payload?.source === 'jellyfin'),
    );
    const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

    const ORIGIN_LABELS: Record<string, string> = {
        handle_error: 'Page error (load or render)',
        window_error: 'Uncaught error',
        unhandled_rejection: 'Unhandled promise rejection',
        error_toast: 'Failure shown to the user',
    };
    const OUTCOME_LABELS: Record<string, string> = {
        status_4xx: 'Client error (4xx)',
        status_5xx: 'Server error (5xx)',
        network: 'Network error',
        timeout: 'Timed out',
        decode: 'Response did not match the contract',
    };

    interface ApiCall {
        method: string;
        route: string;
        outcome: string | null;
        status: number | null;
        problemCode: string | null;
    }
    function apiCall(v: unknown): ApiCall | null {
        if (typeof v !== 'object' || v === null) return null;
        const o = v as Record<string, unknown>;
        const route = text(o.route);
        if (!route) return null;
        return {
            method: text(o.method) ?? '?',
            route,
            outcome: text(o.outcome),
            status: num(o.status),
            problemCode: text(o.problemCode),
        };
    }

    const p = $derived(diagnostic.payload);
    const jsError = $derived(
        diagnostic.kind === 'js_error'
            ? {
                  origin: text(p.origin),
                  name: text(p.name) ?? 'Error',
                  message: text(p.message),
                  stack: text(p.stack),
                  route: text(p.route),
                  toastKey: text(p.toastKey),
                  tag: text(p.tag),
                  errorId: text(p.errorId),
                  cause: apiCall(p.cause),
              }
            : null,
    );
    const apiFailure = $derived(
        diagnostic.kind === 'api_failures'
            ? {
                  call: apiCall(p),
                  requestId: text(p.requestId),
                  keyPath: text(p.keyPath),
                  detail: text(p.detail),
                  windowStart: num(p.windowStart),
                  windowEnd: num(p.windowEnd),
              }
            : null,
    );
    function describeCall(call: ApiCall): string {
        return `${call.method} ${call.route}${call.status !== null ? ` → ${call.status}` : ''}${call.problemCode ? ` (${call.problemCode})` : ''}`;
    }

    let reportOpen = $state(false);
    const blobUrl = $derived(apiUrl('internal', `/admin/diagnostics/${diagnostic.id}/blob`));
</script>

<div class="space-y-4 text-sm">
    <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt class="text-surface-400">Reference</dt>
        <dd class="font-mono">{diagnostic.shortId}</dd>
        <dt class="text-surface-400">Kind</dt>
        <dd>{diagnostic.kind}</dd>
        <dt class="text-surface-400">Platform</dt>
        <dd>{diagnostic.platform}</dd>
        <dt class="text-surface-400">App</dt>
        <dd>
            {diagnostic.appVersion ?? '—'}{diagnostic.appBuild ? ` (${diagnostic.appBuild})` : ''}
        </dd>
        <dt class="text-surface-400">OS / device</dt>
        <dd>{diagnostic.osVersion ?? '—'} · {diagnostic.deviceModel ?? '—'}</dd>
        <dt class="text-surface-400">User / device</dt>
        <dd>
            {diagnostic.username ?? diagnostic.userId ?? '—'} · {diagnostic.deviceName ??
                diagnostic.deviceId ??
                '—'}
        </dd>
        <dt class="text-surface-400">Occurred</dt>
        <dd>{new Date(diagnostic.occurredAt).toLocaleString()}</dd>
        <dt class="text-surface-400">Occurrences</dt>
        <dd>{diagnostic.occurrences}</dd>
        {#if diagnostic.fingerprint}
            <dt class="text-surface-400">Fingerprint</dt>
            <dd class="font-mono break-all">{diagnostic.fingerprint}</dd>
        {/if}
    </dl>

    {#if jsError}
        <section data-testid="js-error-summary">
            <h3 class="mb-1 text-xs uppercase text-surface-400">What happened</h3>
            <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt class="text-surface-400">Source</dt>
                <dd>
                    {jsError.origin ? (ORIGIN_LABELS[jsError.origin] ?? jsError.origin) : '—'}
                    {#if jsError.tag === 'chunk_load'}
                        <span class="badge-soft-yellow ml-1"
                            >chunk load (stale tab after a deploy?)</span>
                    {/if}
                </dd>
                {#if jsError.toastKey}
                    <dt class="text-surface-400">Message key</dt>
                    <dd class="font-mono break-all">{jsError.toastKey}</dd>
                {/if}
                {#if jsError.route}
                    <dt class="text-surface-400">Page</dt>
                    <dd class="font-mono break-all">{jsError.route}</dd>
                {/if}
                {#if jsError.cause}
                    <dt class="text-surface-400">Failed call before it</dt>
                    <dd class="font-mono break-all">{describeCall(jsError.cause)}</dd>
                {/if}
                {#if jsError.errorId}
                    <dt class="text-surface-400">Error page reference</dt>
                    <dd class="font-mono break-all">{jsError.errorId}</dd>
                {/if}
                <dt class="text-surface-400">Error</dt>
                <dd class="break-words">
                    {jsError.name}{jsError.message ? `: ${jsError.message}` : ''}
                </dd>
            </dl>
            {#if jsError.stack}
                <pre
                    class="mt-2 max-h-72 overflow-auto rounded bg-surface-900 p-2 text-xs">{jsError.stack}</pre>
            {/if}
        </section>
    {:else if apiFailure?.call}
        <section data-testid="api-failure-summary">
            <h3 class="mb-1 text-xs uppercase text-surface-400">What happened</h3>
            <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt class="text-surface-400">Request</dt>
                <dd class="font-mono break-all">
                    {apiFailure.call.method}
                    {apiFailure.call.route}
                </dd>
                <dt class="text-surface-400">Outcome</dt>
                <dd>
                    {apiFailure.call.outcome
                        ? (OUTCOME_LABELS[apiFailure.call.outcome] ?? apiFailure.call.outcome)
                        : '—'}{apiFailure.call.status !== null
                        ? ` · HTTP ${apiFailure.call.status}`
                        : ''}
                </dd>
                {#if apiFailure.call.problemCode}
                    <dt class="text-surface-400">Problem code</dt>
                    <dd class="font-mono">{apiFailure.call.problemCode}</dd>
                {/if}
                {#if apiFailure.requestId}
                    <dt class="text-surface-400">Request id</dt>
                    <dd class="font-mono break-all">{apiFailure.requestId}</dd>
                {/if}
                {#if apiFailure.keyPath}
                    <dt class="text-surface-400">Field</dt>
                    <dd class="font-mono break-all">{apiFailure.keyPath}</dd>
                {/if}
                {#if apiFailure.detail}
                    <dt class="text-surface-400">Detail</dt>
                    <dd class="break-words">{apiFailure.detail}</dd>
                {/if}
                {#if apiFailure.windowStart !== null && apiFailure.windowEnd !== null && apiFailure.windowEnd > apiFailure.windowStart}
                    <dt class="text-surface-400">Window</dt>
                    <dd>
                        {new Date(apiFailure.windowStart).toLocaleString()} – {new Date(
                            apiFailure.windowEnd,
                        ).toLocaleTimeString()}
                    </dd>
                {/if}
            </dl>
        </section>
    {/if}

    {#if reportable}
        <button
            type="button"
            class="btn btn-sm variant-filled-primary"
            onclick={() => (reportOpen = true)}>
            {m.admin_clientdiag_report_github()}
        </button>
        <GithubReportDialog
            diagnosticId={diagnostic.id}
            open={reportOpen}
            onclose={() => (reportOpen = false)} />
    {/if}

    {#if diagnostic.blob}
        <div class="flex flex-wrap items-center gap-2">
            <a class="btn btn-sm variant-filled-primary" href={blobUrl} download
                >Download .log.gz</a>
            <a
                class="btn btn-sm variant-soft"
                href={`${blobUrl}?format=text`}
                target="_blank"
                rel="noopener">Open as text</a>
            <span class="text-xs text-surface-400">
                {Math.round(diagnostic.blob.contentBytes / 1024)} KB compressed ·
                {Math.round(diagnostic.blob.uncompressedBytes / 1024)} KB uncompressed
            </span>
        </div>
    {/if}

    {#if logTail?.lines?.length}
        <section>
            <h3 class="mb-1 text-xs uppercase text-surface-400">
                Log tail ({logTail.source === 'previous_run' ? 'previous run' : 'current run'})
            </h3>
            <pre
                class="max-h-72 overflow-auto rounded bg-surface-900 p-2 text-xs">{logTail.lines.join(
                    '\n',
                )}</pre>
        </section>
    {/if}

    <section>
        <h3 class="mb-1 text-xs uppercase text-surface-400">Payload</h3>
        <pre class="max-h-96 overflow-auto rounded bg-surface-900 p-2 text-xs">{JSON.stringify(
                payloadWithoutTail,
                null,
                2,
            )}</pre>
    </section>
</div>
