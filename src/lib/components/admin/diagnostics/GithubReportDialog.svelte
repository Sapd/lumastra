<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Preview of the redacted GitHub report for a Jellyfin-client diagnostic. The
  server builds it (404 on builds without the report builder); nothing leaves
  this page until the admin opens the prefilled issue and attaches the file.
-->
<script lang="ts">
    import { ActionModal } from '$lib/components/admin';
    import { apiGet } from '$lib/api/client';
    import {
        GithubReportResponseSchema,
        type GithubReportResponse,
    } from '$lib/schemas/client-diagnostics';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        diagnosticId: number;
        open: boolean;
        onclose: () => void;
    }

    let { diagnosticId, open, onclose }: Props = $props();

    let report = $state<GithubReportResponse | null>(null);
    let failed = $state(false);
    let loading = $state(false);
    let fetchToken = 0;
    // The excerpt is the part redaction cannot vouch for (titles, names, paths):
    // it is shown openly, not only inside the collapsed JSON.
    const logExcerpt = $derived(
        typeof report?.report.logExcerpt === 'string' && report.report.logExcerpt
            ? report.report.logExcerpt
            : null,
    );

    $effect(() => {
        if (!open) return;
        const id = diagnosticId;
        const token = ++fetchToken;
        loading = true;
        failed = false;
        report = null;
        void apiGet(`/api/admin/diagnostics/${id}/github-report`, GithubReportResponseSchema).then(
            ({ data, error }) => {
                if (token !== fetchToken) return;
                if (error || !data) failed = true;
                else report = data;
                loading = false;
            },
        );
    });

    function download(): void {
        if (!report) return;
        const blob = new Blob([JSON.stringify(report.report, null, 2)], {
            type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `lumastra-jellyfin-report-${diagnosticId}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }
</script>

{#if open}
    <ActionModal title={m.admin_clientdiag_report_title()} {onclose}>
        {#if loading}
            <p class="text-sm text-surface-400">{m.admin_clientdiag_loading()}</p>
        {:else if failed || !report}
            <p class="text-sm text-red-400" role="alert">{m.admin_clientdiag_report_error()}</p>
        {:else}
            <p class="text-sm text-surface-300">{m.admin_clientdiag_report_intro()}</p>
            <pre
                class="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-surface-900 p-2 text-xs">{report.markdown}</pre>
            {#if logExcerpt}
                <p class="text-xs font-medium text-surface-300">
                    {m.admin_clientdiag_report_log()}
                </p>
                <pre
                    class="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-surface-900 p-2 text-xs"
                    data-testid="github-report-log">{logExcerpt}</pre>
            {/if}
            <details>
                <summary class="cursor-pointer text-xs text-surface-400"
                    >{m.admin_clientdiag_report_json()}</summary>
                <pre
                    class="mt-2 max-h-60 overflow-auto rounded bg-surface-900 p-2 text-xs">{JSON.stringify(
                        report.report,
                        null,
                        2,
                    )}</pre>
            </details>
            <p class="text-xs text-surface-400">{m.admin_clientdiag_report_attach_hint()}</p>
        {/if}
        {#snippet footer()}
            <div class="flex flex-wrap gap-3">
                <button type="button" class="btn btn-gray" data-autofocus onclick={() => onclose()}>
                    {m.admin_clientdiag_report_close()}
                </button>
                {#if report}
                    <button type="button" class="btn btn-gray" onclick={download}>
                        {m.admin_clientdiag_report_download()}
                    </button>
                    <a
                        class="btn btn-blue"
                        href={report.issueUrl}
                        target="_blank"
                        rel="noopener noreferrer">{m.admin_clientdiag_report_open()}</a>
                {/if}
            </div>
        {/snippet}
    </ActionModal>
{/if}
