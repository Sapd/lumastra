<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/system/diagnostics — the instance debug report (URL kept from the old
  "Export diagnostics" page; design: docs/superpowers/specs/2026-10-21-admin-debug-report-design.md).

  The server builds and redacts the report (GET /api/admin/debug-report, the cookie
  mirror of the diagnostics:read Bearer endpoint). This page renders the JSON with the
  SAME pure formatter the server uses for format=md (formatDebugReport), so the preview,
  the clipboard and the .md download agree. It also mints the diagnostics:read service
  token an AI agent uses; the token is shown once and cleared when the page is left.
  Admin gating comes from the parent /admin layout.
-->
<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, ClipboardDocument, ArrowDownTray, ArrowPath } from 'svelte-hero-icons';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { apiGet } from '$lib/api/client.js';
    import { createServiceToken } from '$lib/api/admin.js';
    import { toasts } from '$lib/stores/toast.store';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { DebugReportSchema, type DebugReport } from '$lib/schemas/debug-report.js';
    import { formatDebugReport } from '$lib/shared/debug-report-format.js';

    /** Token lifetimes offered in the form; the server caps service tokens at 90 days. */
    const EXPIRY_DAYS = [1, 7, 30, 90] as const;

    let report = $state<DebugReport | null>(null);
    let includeHostnames = $state(false);
    let includePaths = $state(false);
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);
    /** Each load bumps this; a response for an older request is dropped. */
    let loadGeneration = 0;

    let markdown = $derived(report === null ? '' : formatDebugReport(report));
    // The banner follows the report that is shown, not the checkboxes: a refresh still in
    // flight must not claim an include toggle the displayed text does not carry.
    let includeOn = $derived(
        report !== null &&
            (report.redaction.options.includeHostnames || report.redaction.options.includePaths),
    );
    // A failed refresh leaves the previous report in memory; exporting it would hand out a
    // report that no longer matches the toggles or the error on screen.
    let exportDisabled = $derived(report === null || loadError !== null);
    let fileStamp = $derived(report === null ? '' : report.generatedAt.replace(/[:.]/g, '-'));

    async function load(): Promise<void> {
        const generation = ++loadGeneration;
        loading = true;
        loadError = null;
        const include = [includeHostnames ? 'hostnames' : '', includePaths ? 'paths' : '']
            .filter((value) => value !== '')
            .join(',');
        const url =
            '/api/admin/debug-report?format=json' + (include === '' ? '' : `&include=${include}`);
        const { data, error, status } = await apiGet(url, DebugReportSchema);
        if (generation !== loadGeneration) return;
        loading = false;
        if (status === 429) {
            // One report per 10 seconds per credential: a toggle right after a load hits this.
            loadError = {
                class: 'server',
                message: m.admin_debug_report_rate_limited(),
                detail: error ?? undefined,
                retryable: true,
            };
            return;
        }
        if (error || !data) {
            loadError = classifyError(new Error(error ?? undefined), { status });
            return;
        }
        report = data;
    }

    async function copyText(text: string, doneMessage: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            toasts.error(m.admin_transcode_failures_toast_copy_failed());
            return;
        }
        toasts.success(doneMessage);
    }

    function saveFile(content: string, fileName: string, type: string): void {
        const url = URL.createObjectURL(new Blob([content], { type }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    function downloadMarkdown(): void {
        if (exportDisabled) return;
        saveFile(markdown, `lumastra-debug-report-${fileStamp}.md`, 'text/markdown;charset=utf-8');
    }

    function downloadJson(): void {
        if (exportDisabled || report === null) return;
        saveFile(
            JSON.stringify(report, null, 2),
            `lumastra-debug-report-${fileStamp}.json`,
            'application/json;charset=utf-8',
        );
    }

    // ── Agent token ───────────────────────────────────────────────────────────
    let tokenName = $state('AI agent');
    let tokenDays = $state<number>(7);
    let tokenIps = $state('');
    let creatingToken = $state(false);
    /** The one and only copy of the token this page ever holds. */
    let createdToken = $state<{ value: string; origin: string } | null>(null);

    let snippet = $derived(
        createdToken === null
            ? ''
            : `export LUMASTRA_URL="${createdToken.origin}"\nexport LUMASTRA_DIAGNOSTICS_TOKEN="${createdToken.value}"`,
    );

    async function createToken(): Promise<void> {
        const name = tokenName.trim();
        if (name === '') {
            toasts.error(m.admin_debug_report_token_name_required());
            return;
        }
        const allowedIps = tokenIps
            .split(',')
            .map((ip) => ip.trim())
            .filter((ip) => ip !== '');
        // Creating another token replaces the shown one; the old value is dropped first.
        createdToken = null;
        creatingToken = true;
        const { data, error } = await createServiceToken({
            name,
            scopes: ['diagnostics:read'],
            expiresInDays: tokenDays,
            allowedIps: allowedIps.length > 0 ? allowedIps : undefined,
        });
        creatingToken = false;
        if (error || !data) {
            toasts.error(m.admin_debug_report_token_failed({ error: error ?? '' }));
            return;
        }
        createdToken = { value: data.token, origin: window.location.origin };
        toasts.success(m.admin_debug_report_token_created());
    }

    // The token must not outlive the visit: it is shown once, and leaving the page drops it.
    onDestroy(() => {
        createdToken = null;
    });

    // onMount, not $effect: load() reads the include toggles, and an effect would track them
    // and fire a second request (the 10-second rate limit then answers it with a 429).
    onMount(() => {
        void load();
    });
</script>

<svelte:head>
    <title>{m.admin_nav_page_system_diagnostics()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        title={m.admin_nav_page_system_diagnostics()}
        description={m.admin_nav_desc_system_diagnostics()}
        icon={adminPageIcons['/admin/system/diagnostics']} />

    <p class="text-xs text-surface-400">{m.admin_debug_report_intro()}</p>

    <section class="space-y-3">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-6">
            <label class="flex max-w-xs cursor-pointer items-start gap-2 text-sm text-surface-200">
                <input
                    type="checkbox"
                    class="checkbox mt-0.5"
                    checked={includeHostnames}
                    onchange={(event) => {
                        includeHostnames = event.currentTarget.checked;
                        void load();
                    }}
                    disabled={loading} />
                <span class="space-y-0.5">
                    <span class="block">{m.admin_debug_report_include_hostnames()}</span>
                    <span class="block text-xs text-surface-400"
                        >{m.admin_debug_report_include_hostnames_hint()}</span>
                </span>
            </label>
            <label class="flex max-w-xs cursor-pointer items-start gap-2 text-sm text-surface-200">
                <input
                    type="checkbox"
                    class="checkbox mt-0.5"
                    checked={includePaths}
                    onchange={(event) => {
                        includePaths = event.currentTarget.checked;
                        void load();
                    }}
                    disabled={loading} />
                <span class="space-y-0.5">
                    <span class="block">{m.admin_debug_report_include_paths()}</span>
                    <span class="block text-xs text-surface-400"
                        >{m.admin_debug_report_include_paths_hint()}</span>
                </span>
            </label>
        </div>

        {#if includeOn}
            <p
                class="rounded border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-warning-200">
                {m.admin_debug_report_include_warning()}
            </p>
        {/if}

        <div class="flex flex-wrap items-center gap-2">
            <button
                type="button"
                class="btn btn-sm variant-filled-primary inline-flex items-center gap-1"
                disabled={exportDisabled}
                onclick={() => void copyText(markdown, m.admin_debug_report_copied())}>
                <Icon src={ClipboardDocument} class="h-4 w-4" />
                <span>{m.admin_debug_report_copy()}</span>
            </button>
            <button
                type="button"
                class="btn btn-sm variant-soft inline-flex items-center gap-1"
                disabled={exportDisabled}
                onclick={downloadMarkdown}>
                <Icon src={ArrowDownTray} class="h-4 w-4" />
                <span>{m.admin_debug_report_download_md()}</span>
            </button>
            <button
                type="button"
                class="btn btn-sm variant-soft inline-flex items-center gap-1"
                disabled={exportDisabled}
                onclick={downloadJson}>
                <Icon src={ArrowDownTray} class="h-4 w-4" />
                <span>{m.admin_debug_report_download_json()}</span>
            </button>
            <button
                type="button"
                class="btn btn-sm variant-soft inline-flex items-center gap-1"
                disabled={loading}
                onclick={() => void load()}>
                <Icon src={ArrowPath} class="h-4 w-4" />
                <span>{m.admin_debug_report_refresh()}</span>
            </button>
        </div>

        <AsyncSection
            {loading}
            error={loadError}
            empty={report === null && !loading && loadError === null}
            emptyMessage={m.admin_debug_report_empty()}
            onretry={() => void load()}>
            <pre
                class="max-h-[36rem] overflow-auto rounded border border-surface-700/50 bg-surface-900/60 p-4 text-xs leading-relaxed text-surface-200">{markdown}</pre>
        </AsyncSection>
    </section>

    <section class="space-y-4 rounded border border-surface-700/50 p-4">
        <div class="space-y-1">
            <h2 class="text-base font-semibold text-surface-100">
                {m.admin_debug_report_token_title()}
            </h2>
            <p class="text-xs text-surface-400">{m.admin_debug_report_token_intro()}</p>
        </div>

        <form
            class="grid gap-3 sm:grid-cols-2"
            onsubmit={(event) => {
                event.preventDefault();
                void createToken();
            }}>
            <label class="space-y-1 text-sm text-surface-200">
                <span>{m.admin_debug_report_token_name()}</span>
                <input class="input" type="text" maxlength="100" bind:value={tokenName} />
            </label>
            <label class="space-y-1 text-sm text-surface-200">
                <span>{m.admin_debug_report_token_expiry()}</span>
                <select class="select" bind:value={tokenDays}>
                    {#each EXPIRY_DAYS as days (days)}
                        <option value={days}
                            >{days === 1
                                ? m.admin_debug_report_token_day_one()
                                : m.admin_debug_report_token_days({ count: days })}</option>
                    {/each}
                </select>
            </label>
            <label class="space-y-1 text-sm text-surface-200 sm:col-span-2">
                <span>{m.admin_debug_report_token_ips()}</span>
                <input
                    class="input"
                    type="text"
                    bind:value={tokenIps}
                    placeholder="203.0.113.7, 198.51.100.4" />
                <span class="block text-xs text-surface-400"
                    >{m.admin_debug_report_token_ips_hint()}</span>
            </label>
            <div class="sm:col-span-2">
                <button
                    type="submit"
                    class="btn btn-sm variant-filled-primary"
                    disabled={creatingToken}>
                    {m.admin_debug_report_token_create()}
                </button>
            </div>
        </form>

        {#if createdToken !== null}
            <div class="space-y-3 rounded border border-success-500/40 bg-success-500/5 p-3">
                <p class="text-sm font-medium text-surface-100">
                    {m.admin_debug_report_token_once()}
                </p>
                <div class="space-y-1">
                    <span class="text-xs text-surface-400"
                        >{m.admin_debug_report_token_value()}</span>
                    <div class="flex flex-wrap gap-2">
                        <input
                            class="input min-w-0 flex-1 font-mono text-xs"
                            type="text"
                            readonly
                            value={createdToken.value} />
                        <button
                            type="button"
                            class="btn btn-sm variant-soft inline-flex items-center gap-1"
                            onclick={() =>
                                void copyText(
                                    createdToken?.value ?? '',
                                    m.admin_debug_report_token_copied(),
                                )}>
                            <Icon src={ClipboardDocument} class="h-4 w-4" />
                            <span>{m.admin_debug_report_token_copy()}</span>
                        </button>
                    </div>
                </div>
                <div class="space-y-1">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <span class="text-xs text-surface-400"
                            >{m.admin_debug_report_snippet_label()}</span>
                        <button
                            type="button"
                            class="btn btn-sm variant-soft inline-flex items-center gap-1"
                            onclick={() =>
                                void copyText(snippet, m.admin_debug_report_token_copied())}>
                            <Icon src={ClipboardDocument} class="h-4 w-4" />
                            <span>{m.admin_debug_report_copy_snippet()}</span>
                        </button>
                    </div>
                    <pre
                        class="overflow-auto rounded border border-surface-700/50 bg-surface-900/60 p-3 text-xs text-surface-200">{snippet}</pre>
                </div>
            </div>
        {/if}

        <a
            class="inline-block text-xs text-primary-400 underline"
            href="https://lumastra.org/guides/debugging-with-ai/"
            target="_blank"
            rel="noopener noreferrer">{m.admin_debug_report_docs_link()}</a>
    </section>
</div>
