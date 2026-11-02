<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Admin IA redesign, spec §3.4: the Health page's "#security" section. Moved
  wholesale from the deleted standalone `/admin/security` page (the working
  parts only — the page-header chrome now belongs to Health itself). Runs a
  read-only runtime posture check per auth method on demand; no secret values
  are ever shown.
-->
<script lang="ts">
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import { apiPost } from '$lib/api/client.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        SecuritySelfCheckReportSchema,
        type SecuritySelfCheckReport,
        type SecuritySelfCheckFinding,
        type SecuritySelfCheckMethod,
        type SecuritySelfCheckStatus,
    } from '$lib/schemas/security-self-check.js';
    import { securityStatusSeverity } from './security-self-check-display.js';

    let report = $state<SecuritySelfCheckReport | null>(null);
    let loadError = $state<string | null>(null);
    let running = $state(false);

    async function runChecks(): Promise<void> {
        // The error banner's Retry is not disabled while a run is in flight;
        // each run mints a service token and probes the public URL.
        if (running) return;
        running = true;
        loadError = null;
        const { data, error } = await apiPost(
            '/api/admin/security-self-check/run',
            SecuritySelfCheckReportSchema,
            {},
        );
        if (error || !data) {
            loadError = error ?? m.admin_security_failed();
        } else {
            report = data;
        }
        running = false;
    }

    // Display order for each auth method / surface group.
    const METHOD_ORDER: SecuritySelfCheckMethod[] = [
        'forward-auth',
        'edge',
        'native',
        'oidc',
        'token',
        'secrets',
        'jellyfin-compat',
        'subsonic-compat',
    ];

    function methodLabel(method: SecuritySelfCheckMethod): string {
        switch (method) {
            case 'forward-auth':
                return m.admin_security_method_forward_auth();
            case 'edge':
                return m.admin_security_method_edge();
            case 'native':
                return m.admin_security_method_native();
            case 'oidc':
                return m.admin_security_method_oidc();
            case 'token':
                return m.admin_security_method_token();
            case 'secrets':
                return m.admin_security_method_secrets();
            case 'jellyfin-compat':
                return m.admin_security_method_jellyfin_compat();
            case 'subsonic-compat':
                return m.admin_security_method_subsonic_compat();
        }
    }

    function statusLabel(status: SecuritySelfCheckStatus): string {
        switch (status) {
            case 'pass':
                return m.admin_security_status_pass();
            case 'warn':
                return m.admin_security_status_warn();
            case 'fail':
                return m.admin_security_status_fail();
            case 'error':
                return m.admin_security_status_error();
            case 'info':
                return m.admin_security_status_info();
            case 'skipped':
                return m.admin_security_status_skipped();
        }
    }

    // Worst status drives the group header dot — ranking lives in
    // `security-self-check-display.ts` as an exhaustive switch. It was a
    // `Record<SecuritySelfCheckStatus, number>` here, checked by nothing (tsgo
    // skips `.svelte`; svelte-check-native does not flag a broken key in one),
    // and an unranked status compares false against everything, so the group
    // would have kept its starting `'pass'` and shown a green dot over a red
    // finding.

    interface MethodGroup {
        method: SecuritySelfCheckMethod;
        label: string;
        findings: SecuritySelfCheckFinding[];
        worst: SecuritySelfCheckStatus;
    }

    let groups = $derived.by<MethodGroup[]>(() => {
        const current = report;
        if (!current) return [];
        const result: MethodGroup[] = [];
        for (const method of METHOD_ORDER) {
            const findings = current.findings.filter((f) => f.method === method);
            if (findings.length === 0) continue;
            let worst: SecuritySelfCheckStatus = 'pass';
            for (const f of findings) {
                if (securityStatusSeverity(f.status) > securityStatusSeverity(worst))
                    worst = f.status;
            }
            result.push({ method, label: methodLabel(method), findings, worst });
        }
        return result;
    });

    function statusBadgeClass(status: SecuritySelfCheckStatus): string {
        switch (status) {
            case 'pass':
                return 'bg-green-900/50 text-green-300';
            case 'warn':
                return 'bg-amber-900/50 text-amber-300';
            case 'fail':
                return 'bg-red-900/50 text-red-300';
            case 'error':
                return 'bg-purple-900/50 text-purple-300';
            case 'info':
                return 'bg-sky-900/50 text-sky-300';
            case 'skipped':
            default:
                return 'bg-surface-700 text-surface-400';
        }
    }

    function statusDotClass(status: SecuritySelfCheckStatus): string {
        switch (status) {
            case 'pass':
                return 'bg-green-400';
            case 'warn':
                return 'bg-amber-400';
            case 'fail':
                return 'bg-red-400';
            case 'error':
                return 'bg-purple-400';
            case 'info':
                return 'bg-sky-400';
            case 'skipped':
            default:
                return 'bg-surface-600';
        }
    }
</script>

<div class="space-y-4">
    <div>
        <h2 class="text-sm font-semibold uppercase tracking-wide text-surface-300">
            {m.admin_security_title()}
        </h2>
        <p class="mt-1 text-xs text-surface-500">{m.admin_security_description()}</p>
    </div>

    <div class="flex items-center gap-3">
        <button type="button" class="btn btn-primary" onclick={runChecks} disabled={running}>
            {#if running}
                <Icon src={ArrowPath} class="w-4 h-4 animate-spin mr-2" />
                {m.admin_security_running()}
            {:else}
                {m.admin_security_run()}
            {/if}
        </button>
        {#if report}
            <p class="text-xs text-surface-500">
                {m.admin_security_last_run({ time: new Date(report.ranAt).toLocaleString() })}
            </p>
        {/if}
    </div>

    {#if loadError}
        <div
            class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300 flex items-center gap-3">
            <span class="flex-1">{loadError}</span>
            <button type="button" class="btn btn-secondary" onclick={runChecks}
                >{m.common_retry()}</button>
        </div>
    {/if}

    {#if report}
        <!-- Summary strip -->
        <div class="flex flex-wrap gap-2">
            <span class="rounded px-2 py-1 text-xs {statusBadgeClass('pass')}">
                {report.summary.pass}
                {statusLabel('pass')}
            </span>
            <span class="rounded px-2 py-1 text-xs {statusBadgeClass('warn')}">
                {report.summary.warn}
                {statusLabel('warn')}
            </span>
            <span class="rounded px-2 py-1 text-xs {statusBadgeClass('fail')}">
                {report.summary.fail}
                {statusLabel('fail')}
            </span>
            <span class="rounded px-2 py-1 text-xs {statusBadgeClass('info')}">
                {report.summary.info}
                {statusLabel('info')}
            </span>
            <span class="rounded px-2 py-1 text-xs {statusBadgeClass('skipped')}">
                {report.summary.skipped}
                {statusLabel('skipped')}
            </span>
            <span class="rounded px-2 py-1 text-xs {statusBadgeClass('error')}">
                {report.summary.error}
                {statusLabel('error')}
            </span>
        </div>

        <!-- Findings grouped by auth method -->
        <div class="space-y-6">
            {#each groups as group (group.method)}
                <section class="space-y-3">
                    <div class="flex items-center gap-2">
                        <span
                            class="inline-block h-3 w-3 rounded-full {statusDotClass(group.worst)}">
                            <span class="sr-only">{statusLabel(group.worst)}</span>
                        </span>
                        <h3 class="text-sm font-semibold text-surface-200">{group.label}</h3>
                        <span class="text-xs text-surface-500">({group.findings.length})</span>
                    </div>

                    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        {#each group.findings as f (f.id)}
                            <div class="card-bordered p-4 space-y-2">
                                <div class="flex items-start gap-2">
                                    <h4 class="text-sm font-medium text-surface-200 flex-1">
                                        {f.title}
                                    </h4>
                                    <span
                                        class="rounded px-1.5 py-0.5 text-xs uppercase tracking-wide {statusBadgeClass(
                                            f.status,
                                        )}">
                                        {statusLabel(f.status)}
                                    </span>
                                </div>
                                <p class="text-xs text-surface-400">{f.detail}</p>
                                {#if f.remediation}
                                    <p class="text-xs text-surface-300">
                                        <span class="font-semibold text-surface-200"
                                            >{m.admin_security_remediation_label()}</span>
                                        {f.remediation}
                                    </p>
                                {/if}
                                <div
                                    class="flex flex-wrap items-center gap-2 text-[11px] text-surface-500">
                                    <span class="rounded bg-surface-800 px-1.5 py-0.5"
                                        >{f.type}</span>
                                    <span class="font-mono">{f.id}</span>
                                    {#if f.evidence}
                                        <span class="font-mono text-surface-600"
                                            >· {f.evidence}</span>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>
                </section>
            {/each}
        </div>
    {:else if !running && !loadError}
        <p class="text-sm text-surface-400">{m.admin_security_empty()}</p>
    {/if}
</div>
