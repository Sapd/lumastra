<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Admin IA redesign, spec §3.4: System → Health, the promoted System-section
  landing page. Order (each block an anchor for badge deep-links): open
  findings → components → optional dependencies → provider health → file
  health & integrity → security self-check → aggregated activity log →
  trends. Cluster stays as its own tab (`?tab=cluster`).
-->
<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import { z } from 'zod';
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import AdminWorkspaceTabs from '$lib/components/admin/AdminWorkspaceTabs.svelte';
    import { tabItemsOf } from '$lib/config/admin-search-meta';
    import { searchMeta } from './search-meta';
    import {
        healthView,
        healthViewUrl,
        healthSummary,
        healthComponentEntries,
    } from '$lib/components/admin/system-health/health-workspace';
    import { overallHealthVerdict } from '$lib/shared/health-verdict.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import { apiGet } from '$lib/api/client.js';
    import { resolve } from '$lib/paths';
    import { ADMIN_MEDIA_FILE_ISSUES_PATH } from '$lib/shared/admin-media-links.js';
    import SystemHealthRail from '$lib/components/admin/runs/SystemHealthRail.svelte';
    import ClusterPanel from '$lib/components/admin/cluster/ClusterPanel.svelte';
    import ClusterEncoderCheck from '$lib/components/admin/cluster/ClusterEncoderCheck.svelte';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { adminStatus } from '$lib/stores/admin-status.store.svelte.js';
    import AttentionList from '$lib/components/admin/attention/AttentionList.svelte';
    import ServiceHealthGrid from '$lib/components/admin/ServiceHealthGrid.svelte';
    import SecuritySelfCheckPanel from '$lib/components/admin/system-health/SecuritySelfCheckPanel.svelte';
    import SafeToRestart from '$lib/components/admin/system-health/SafeToRestart.svelte';
    import ChangeTimeline from '$lib/components/admin/system-health/ChangeTimeline.svelte';
    import PreviewAdmissionCard from '$lib/components/admin/PreviewAdmissionCard.svelte';
    import HealthInvariantsPanel from '$lib/components/admin/system-health/HealthInvariantsPanel.svelte';
    import ApiConformanceCard from '$lib/components/admin/system-health/ApiConformanceCard.svelte';
    import DependencyChecksPanel from '$lib/components/admin/system-health/DependencyChecksPanel.svelte';
    import FileHealthListPanel from '$lib/components/admin/system-health/FileHealthListPanel.svelte';
    import TaskSystemHealthBanner from '$lib/components/admin/system-health/TaskSystemHealthBanner.svelte';
    import SubsystemLivenessGrid from '$lib/components/admin/system-health/SubsystemLivenessGrid.svelte';
    import ClassLeaderStrip from '$lib/components/admin/system-health/ClassLeaderStrip.svelte';
    import SystemicFailuresCard from '$lib/components/admin/task-system/SystemicFailuresCard.svelte';
    import TrendChart from '$lib/components/admin/task-system/TrendChart.svelte';
    import AuditFeed from '$lib/components/admin/task-system/AuditFeed.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import {
        isHealthFilesIntegrityItem,
        isHealthFilesPanelItem,
    } from '$lib/shared/attention-health-files-panel.js';
    import {
        ObservabilityResponseSchema,
        type ObservabilityResponse,
    } from '$lib/schemas/task-system-observability.schema.js';

    const ComponentHealthSchema = z
        .object({
            status: z.enum(['pass', 'warn', 'fail']),
            reason: z.string().optional(),
            error: z.string().optional(),
            isLeaderForAnyClass: z.boolean().optional(),
            pending: z.number().optional(),
            dead: z.number().optional(),
            depth: z.number().optional(),
            // transcoder fields
            available: z.boolean().optional(),
            engine: z.string().nullable().optional(),
            // migration fields
            currentVersion: z.string().optional(),
            appliedMigrations: z.number().optional(),
            pendingMigrations: z.number().optional(),
        })
        .catchall(z.unknown());

    const HealthReportSchema = z
        .object({
            timestamp: z.string().optional(),
        })
        .catchall(ComponentHealthSchema);

    type ComponentHealth = z.infer<typeof ComponentHealthSchema>;
    type HealthReport = z.infer<typeof HealthReportSchema>;

    type ValkeyCapacityInstance = {
        name: 'cache' | 'tasks' | 'shared';
        roles: Array<'cache' | 'tasks'>;
        usedBytes: number;
        maxBytes: number;
        usagePercent: number | null;
        maxmemoryPolicy: string | null;
        keyCount: number;
        status: 'pass' | 'warn' | 'fail';
        reason?: string;
    };

    let report = $state<HealthReport | null>(null);
    let loadError = $state<string | null>(null);
    let loading = $state(true);
    let sseConnected = $state(false);

    // Task-system observability (Slice 0): subsystem heartbeats, resource-class
    // leaders, latest boot-recovery row. Polled alongside the component health.
    let observability = $state<ObservabilityResponse | null>(null);
    let observabilityError = $state(false);
    let bootBannerDismissed = $state(false);

    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let unsubSSE: (() => void) | undefined;
    let destroyed = false;

    // Polls every 15 s plus manual retries: only the newest response may land,
    // or a slow older snapshot flips the verdict back to a stale state.
    let healthSeq = 0;
    let observabilitySeq = 0;

    async function fetchHealth(): Promise<void> {
        const seq = ++healthSeq;
        const { data, error } = await apiGet('/api/health/components', HealthReportSchema);
        if (destroyed || seq !== healthSeq) return;
        if (error || !data) {
            loadError = error ?? m.admin_health_fetch_failed();
        } else {
            report = data;
            loadError = null;
        }
        if (!destroyed) loading = false;
    }

    async function fetchObservability(): Promise<void> {
        const seq = ++observabilitySeq;
        const { data, error } = await apiGet(
            '/api/admin/task-system/observability',
            ObservabilityResponseSchema,
        );
        if (destroyed || seq !== observabilitySeq) return;
        observabilityError = !!error || !data;
        if (data) observability = data;
    }

    function retryFetch(): void {
        // Manual retry from the error UI — clear the prior error so the
        // banner doesn't linger if the next request also fails synchronously.
        loadError = null;
        loading = true;
        void fetchHealth();
        void fetchObservability();
        void adminStatus.refresh();
    }

    onMount(() => {
        runSSEBus.connect();
        // The one canonical status payload (spec §5) — feeds #findings,
        // #providers and #files below. Ref-counted; AttentionList below also
        // starts/stops it, so this is a harmless extra ref, not a double-poll.
        adminStatus.start();

        unsubSSE = runSSEBus.onAnyChange(() => {
            sseConnected = runSSEBus.connected;
        });
        sseConnected = runSSEBus.connected;

        void fetchHealth();
        void fetchObservability();
        pollTimer = setInterval(() => {
            void fetchHealth();
            void fetchObservability();
        }, 15_000);
    });

    onDestroy(() => {
        destroyed = true;
        runSSEBus.disconnect();
        adminStatus.stop();
        unsubSSE?.();
        if (pollTimer) clearInterval(pollTimer);
    });

    function statusClass(status: ComponentHealth['status']): string {
        return capacityStatusClass(status);
    }

    function statusLabel(status: ComponentHealth['status']): string {
        return status === 'warn'
            ? m.admin_redesign_health_warning()
            : status === 'pass'
              ? m.admin_health_status_ok()
              : m.admin_health_status_down();
    }

    type HealthComponent = { name: string; data: ComponentHealth };

    let components = $derived.by<HealthComponent[]>(() =>
        healthComponentEntries(report).map(({ name, data }) => ({
            name,
            data: data as ComponentHealth,
        })),
    );

    let valkeyCapacity = $derived.by<ValkeyCapacityInstance[]>(() => {
        const entry = report?.valkeyCapacity as { instances?: unknown } | undefined;
        if (!Array.isArray(entry?.instances)) return [];
        return entry.instances.filter(
            (instance): instance is ValkeyCapacityInstance =>
                typeof instance === 'object' &&
                instance !== null &&
                'name' in instance &&
                'usedBytes' in instance &&
                'status' in instance,
        );
    });

    function formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        const units = ['KiB', 'MiB', 'GiB', 'TiB'];
        let value = bytes;
        let unit = -1;
        do {
            value /= 1024;
            unit += 1;
        } while (value >= 1024 && unit < units.length - 1);
        return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
    }

    function valkeyInstanceLabel(instance: ValkeyCapacityInstance): string {
        if (instance.name === 'shared') return 'Shared Valkey (cache + tasks)';
        return instance.name === 'tasks' ? 'Task / coordination Valkey' : 'Cache Valkey';
    }

    function capacityStatusClass(status: ValkeyCapacityInstance['status']): string {
        if (status === 'pass') return 'bg-green-400';
        if (status === 'warn') return 'bg-amber-400';
        return 'bg-red-400';
    }

    function isOk(c: ComponentHealth): boolean | undefined {
        if (c.status === 'pass') return true;
        if (c.status === 'fail') return false;
        if (c.status === 'warn') return false;
        return undefined;
    }

    function describeComponent(name: string, c: ComponentHealth): string {
        const parts: string[] = [];
        if (c.reason) parts.push(c.reason);
        if (c.error) parts.push(c.error);
        if (name === 'orchestrator') {
            if (c.isLeaderForAnyClass !== undefined) {
                parts.push(
                    c.isLeaderForAnyClass
                        ? m.admin_health_orchestrator_handling()
                        : m.admin_health_orchestrator_standby(),
                );
            }
        }
        if (name === 'webhookOutbox') {
            if (c.pending !== undefined)
                parts.push(m.admin_health_waiting_to_send({ count: c.pending }));
            if (c.dead !== undefined) parts.push(m.admin_health_undeliverable({ count: c.dead }));
        }
        if (name === 'pendingWriteDrain') {
            if (c.depth !== undefined)
                parts.push(m.admin_health_waiting_to_save({ count: c.depth }));
        }
        return parts.join(' · ');
    }

    let bootBanner = $derived.by(() => {
        const b = observability?.bootRecovery;
        if (!b || bootBannerDismissed) return null;
        const when = new Date(b.finishedAt).toLocaleTimeString();
        return m.admin_health_boot_recovery({
            instanceId: b.instanceId,
            count: b.reclaimed,
            when,
        });
    });

    // Tab strip (System / Cluster) driven by the ?tab= URL query param. Default
    // to 'system' when absent or unrecognised. The Cluster panel owns its own
    // polling and is only mounted while active so its 10s poller doesn't run
    // while viewing System.
    let activeTab = $derived(healthView($page.url));

    async function selectTab(tab: string): Promise<void> {
        const url = healthViewUrl($page.url, tab);
        await goto(url.toString(), {
            keepFocus: true,
            noScroll: true,
        });
    }

    // Fragment navigation must scroll after the selected view becomes visible.
    $effect(() => {
        const hash = $page.url.hash;
        if (hash) void tick().then(() => document.getElementById(hash.slice(1))?.scrollIntoView());
    });

    // ── #providers: provider & service connections (spec §3.4/§3.6 "Health
    //    status renders once"). Reuses the SAME payload field the old
    //    dashboard's ServiceHealthGrid read — single source of truth, no new
    //    fetch. Merges in extras.serviceVersions the same way the pre-redesign
    //    dashboard did. ──────────────────────────────────────────────────────
    let servicesWithVersions = $derived.by(() => {
        const payload = adminStatus.payload;
        if (!payload?.system.services) return undefined;
        const versions = payload.extras?.serviceVersions;
        if (!versions) return payload.system.services;
        const result: Record<
            string,
            {
                configured: boolean;
                label: string;
                version?: string;
                probe?: { status: 'pass' | 'warn' };
            }
        > = {};
        for (const [key, service] of Object.entries(payload.system.services)) {
            const version = versions[key];
            result[key] = version ? { ...service, version } : service;
        }
        return result;
    });

    // ── #files: file-health & integrity summaries (spec §3.4). These are
    //    already-derived attention items (same payload, same array as
    //    #findings/the bell) — filtered to the two PRODUCERS this panel is
    //    about, by id namespace.
    //
    //    Filtering on `i.type` instead flagged in every music-hygiene item too:
    //    `AttentionType` is a closed enum a new producer cannot grow without a
    //    migration, so `adaptMusicHygiene` reuses the nearest member
    //    (`integrity`), and a calm tagging nudge rendered next to genuine file
    //    damage — and took the integrity link branch below while it was there.
    //    See `attention-health-files-panel.ts`. ──────────────────────────────
    let fileHealthItems = $derived(
        (adminStatus.payload?.attention.items ?? []).filter(isHealthFilesPanelItem),
    );
    let attentionUnavailable = $derived(
        !adminStatus.payload || !!adminStatus.error || !!adminStatus.payload.attention.unavailable,
    );

    /**
     * Whether to fetch the file-level list below the summaries.
     *
     * Gated on the already-polled attention payload rather than fetched
     * unconditionally: `/api/admin/media/file-health` runs two queries over
     * `media_files`, and on a healthy install every one of them would return
     * nothing. `adaptFileHealth` emits its item only for a non-zero count, so
     * this is exactly "the badge has something to show".
     */

    // Keep the first viewport focused on the operator's decision: is there
    // anything that needs intervention right now? The detailed health blocks
    // remain below for diagnosis, but the verdict should never be hidden in
    // the middle of a long telemetry page.
    let summary = $derived(healthSummary(adminStatus.payload, !!adminStatus.error));
    // The server owns the attention verdict. Missing diagnostics must still
    // prevent an overall all-clear; known critical findings remain visible.
    let incomplete = $derived(
        attentionUnavailable ||
            !report ||
            components.length === 0 ||
            loading ||
            !!loadError ||
            !observability ||
            observability?.health.status === 'unknown' ||
            observabilityError,
    );
    // One precedence for every input: a known problem always shows; missing
    // data only turns "healthy" into "check incomplete" (see health-verdict.ts).
    let displayVerdict = $derived(
        overallHealthVerdict({
            attention: summary.verdict,
            components: [
                ...components.map((c) => c.data.status),
                ...valkeyCapacity.map((c) => c.status),
            ],
            taskSystem: observability ? observability.health.status : null,
            incomplete,
        }),
    );
    let healthVerdict = $derived(
        displayVerdict === 'unknown'
            ? m.admin_home_verdict_check_incomplete()
            : displayVerdict === 'critical'
              ? m.admin_ops_verdict_critical()
              : displayVerdict === 'degraded'
                ? m.admin_ops_verdict_degraded()
                : m.admin_home_verdict_healthy(),
    );
    let diagnosticIssues = $derived(components.filter((c) => c.data.status !== 'pass'));
    let views = $derived(
        tabItemsOf(searchMeta)
            // The Cluster tab is always shown: besides replicas it lists every service
            // (worker, Live TV proxy, sonic sidecar) and the host they run on, which
            // matters on a single-host install too.
            .map((tab) => ({
                ...tab,
                count: tab.id === 'overview' ? summary.count : undefined,
            })),
    );
</script>

<svelte:head>
    <title>{m.admin_nav_page_system_health()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/system/health']}
        title={m.admin_health_title()}
        description={m.admin_health_description()} />

    <div class="health-verdict health-verdict-{displayVerdict}" aria-live="polite">
        <div>
            <p class="health-verdict-label">{m.admin_redesign_health_verdict()}</p>
            <p class="health-verdict-title">{healthVerdict}</p>
            <p class="health-verdict-detail">
                {m.admin_health_last_checked()}
                {adminStatus.lastUpdatedAt?.toLocaleTimeString() ?? m.admin_health_status_unknown()}
            </p>
        </div>
        <a href="#findings" class="health-verdict-action">{m.admin_ops_attention_heading()} ↓</a>
    </div>

    <AdminWorkspaceTabs
        label={m.admin_health_views_label()}
        items={views}
        value={activeTab}
        onchange={(view) => void selectTab(view)} />

    {#if incomplete}
        <div
            class="rounded-lg border border-amber-500/40 bg-amber-950/20 p-4 text-sm text-amber-200"
            role="status">
            <p>{m.admin_redesign_health_incomplete()}</p>
            {#if loadError}<p class="mt-1 text-xs">{loadError}</p>{/if}
            <button type="button" class="btn btn-secondary mt-3" onclick={retryFetch}
                >{m.common_retry()}</button>
        </div>
    {/if}

    {#if diagnosticIssues.length > 0 || valkeyCapacity.some((instance) => instance.status !== 'pass')}
        <div class="rounded-lg border border-amber-500/40 p-4 space-y-2">
            <h2 class="text-sm font-semibold text-amber-200">
                {m.admin_redesign_health_component_findings()}
            </h2>
            {#each diagnosticIssues as component (component.name)}
                <p class="text-sm text-surface-300">
                    <a class="text-sky-300 underline" href="#components">{component.name}</a>
                    · {component.data.status === 'fail'
                        ? m.admin_health_status_down()
                        : m.admin_redesign_health_warning()}
                    {describeComponent(component.name, component.data)}
                </p>
            {/each}
            {#each valkeyCapacity.filter((instance) => instance.status !== 'pass') as instance (instance.name)}
                <p class="text-sm text-surface-300">
                    <a class="text-sky-300 underline" href="#components"
                        >{valkeyInstanceLabel(instance)}</a>
                    · {instance.reason ?? m.admin_redesign_health_warning()}
                </p>
            {/each}
        </div>
    {/if}

    {#if observability && observability.health.status !== 'healthy'}
        <TaskSystemHealthBanner health={observability.health} />
    {/if}

    {#if activeTab === 'cluster'}
        <ClusterPanel />
        <ClusterEncoderCheck />
    {:else}
        <!-- 1. Open findings — the SAME array as the bell/Home (spec §5); a
             "show acknowledged" filter reveals quiet/resolved items. -->
        <div hidden={activeTab !== 'overview'} class="space-y-5">
            <section id="findings" class="scroll-mt-20 lg:scroll-mt-32 space-y-2">
                <h2 class="text-sm font-semibold uppercase tracking-wide text-surface-300">
                    {m.admin_health_section_findings()}
                </h2>
                <AttentionList allowAcknowledgedToggle showVerdict={false} />
            </section>

            <!-- Context and safe-operation checks come after the actionable list.
             They are valuable diagnosis tools, but should not push findings
             below the fold on a page whose primary job is triage. -->
            <ApiConformanceCard />
            <SafeToRestart />
        </div>

        <div hidden={activeTab !== 'diagnostics'} class="space-y-6">
            <p class="text-sm text-surface-400">{m.admin_redesign_health_diagnostics_help()}</p>
            <nav class="health-jump-nav" aria-label={m.admin_redesign_health_sections()}>
                <a href="#components">{m.admin_health_section_components()}</a>
                <a href="#dependencies">{m.admin_redesign_health_dependencies()}</a>
                <a href="#providers">{m.admin_health_section_providers()}</a>
                <a href="#files">{m.admin_health_section_files()}</a>
                <a href="#security">{m.admin_redesign_health_security()}</a>
            </nav>
            <PreviewAdmissionCard />

            <!-- 2. Components — task-system rollup, subsystem liveness, invariants,
             and the raw component-health grid. -->
            <section id="components" class="scroll-mt-20 lg:scroll-mt-32 space-y-4">
                <h2 class="text-sm font-semibold uppercase tracking-wide text-surface-300">
                    {m.admin_health_section_components()}
                </h2>

                {#if observability && observability.health.status === 'healthy'}
                    <TaskSystemHealthBanner health={observability.health} />
                    <p class="-mt-1 text-[11px] text-surface-500">
                        {m.route_admin_health_live_note()}
                    </p>
                {/if}

                <SystemHealthRail />

                <!-- Boot-recovery banner (Slice 0): latest boot_recovery_log row, dismissible. -->
                {#if bootBanner}
                    <div
                        class="rounded border border-amber-800/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-200 flex items-center gap-3">
                        <span class="flex-1">{bootBanner}</span>
                        <button
                            type="button"
                            class="btn btn-secondary"
                            onclick={() => (bootBannerDismissed = true)}
                            >{m.admin_system_health_dismiss()}</button>
                    </div>
                {/if}

                <!-- Subsystem liveness + leader map + schedule countdown (Slice 1). -->
                {#if observability}
                    <SubsystemLivenessGrid subsystems={observability.subsystems} />
                    <ClassLeaderStrip leaders={observability.leaders} />
                {/if}

                <HealthInvariantsPanel />

                {#if valkeyCapacity.length > 0}
                    <div class="space-y-2" aria-label="Valkey capacity">
                        <div class="flex items-baseline justify-between gap-3">
                            <h3 class="text-sm font-semibold text-surface-200">Valkey capacity</h3>
                            <p class="text-xs text-surface-500">
                                Green ≤70% · warning >70% · critical >80% · near exhaustion >95%
                            </p>
                        </div>
                        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {#each valkeyCapacity as instance (instance.name)}
                                <div class="card-bordered space-y-3 p-4">
                                    <div class="flex items-center gap-2">
                                        <span
                                            class="inline-block h-3 w-3 rounded-full {capacityStatusClass(
                                                instance.status,
                                            )}">
                                            <span class="sr-only">{instance.status}</span>
                                        </span>
                                        <h4 class="text-sm font-semibold text-surface-200">
                                            {valkeyInstanceLabel(instance)}
                                        </h4>
                                        <span class="ml-auto text-xs text-surface-400">
                                            {instance.usagePercent === null
                                                ? 'No memory limit'
                                                : `${instance.usagePercent}% used`}
                                        </span>
                                    </div>
                                    <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                                        <span class="text-surface-500">Memory</span>
                                        <span class="text-right text-surface-300">
                                            {formatBytes(instance.usedBytes)}
                                            {instance.maxBytes > 0
                                                ? ` / ${formatBytes(instance.maxBytes)}`
                                                : ''}
                                        </span>
                                        <span class="text-surface-500">Policy</span>
                                        <span class="text-right font-mono text-surface-300">
                                            {instance.maxmemoryPolicy ?? 'unknown'}
                                        </span>
                                        <span class="text-surface-500">Keys</span>
                                        <span class="text-right text-surface-300">
                                            {instance.keyCount.toLocaleString()}
                                        </span>
                                    </div>
                                    {#if instance.reason}
                                        <p
                                            class="text-xs {instance.status === 'fail'
                                                ? 'text-red-300'
                                                : 'text-amber-300'}">
                                            {instance.reason}
                                        </p>
                                    {/if}
                                </div>
                            {/each}
                        </div>
                    </div>
                {/if}

                {#if loading}
                    <div class="flex items-center justify-center py-12 text-surface-400">
                        <Icon src={ArrowPath} class="w-6 h-6 animate-spin mr-2" />
                        <span class="text-sm">{m.common_loading()}</span>
                    </div>
                {:else if loadError}
                    <div
                        class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300 flex items-center gap-3">
                        <span class="flex-1">{loadError}</span>
                        <button type="button" class="btn btn-secondary" onclick={retryFetch}
                            >{m.common_retry()}</button>
                    </div>
                {:else if report}
                    {#if report.timestamp}
                        <p class="text-xs text-surface-500">
                            {m.admin_health_last_checked()}
                            {new Date(report.timestamp).toLocaleTimeString()}
                        </p>
                    {/if}

                    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {#each components as c (c.name)}
                            {@const ok = isOk(c.data)}
                            {@const detail = describeComponent(c.name, c.data)}
                            <div class="card-bordered p-4 space-y-3">
                                <div class="flex items-center gap-2">
                                    <span
                                        class="inline-block h-3 w-3 rounded-full {statusClass(
                                            c.data.status,
                                        )}">
                                        <span class="sr-only"
                                            >{ok === true
                                                ? m.route_admin_cache_healthy()
                                                : ok === false
                                                  ? m.providers_status_unhealthy()
                                                  : m.misc_unknown()}</span>
                                    </span>
                                    <h3 class="text-sm font-semibold text-surface-200">
                                        {c.name}
                                    </h3>
                                    <span
                                        class="ml-auto rounded px-1.5 py-0.5 text-xs {ok === true
                                            ? 'bg-green-900/50 text-green-300'
                                            : c.data.status === 'warn'
                                              ? 'bg-amber-900/50 text-amber-300'
                                              : ok === false
                                                ? 'bg-red-900/50 text-red-300'
                                                : 'bg-surface-700 text-surface-400'}">
                                        {statusLabel(c.data.status)}
                                    </span>
                                </div>
                                {#if detail}
                                    <p class="text-xs text-surface-400">{detail}</p>
                                {/if}
                                <!-- Raw detail block for operator debugging -->
                                <details class="group">
                                    <summary
                                        class="cursor-pointer text-xs text-surface-500 hover:text-surface-300 transition-colors">
                                        {m.admin_health_raw_data()}
                                    </summary>
                                    <pre
                                        class="mt-2 overflow-x-auto rounded bg-surface-900 p-2 text-xs text-surface-300">{JSON.stringify(
                                            c.data,
                                            null,
                                            2,
                                        )}</pre>
                                </details>
                            </div>
                        {/each}
                    </div>

                    <!-- SSE status summary (surfaced from runSSEBus) -->
                    <div class="card-bordered p-4">
                        <div class="flex items-center gap-2">
                            <span
                                class="inline-block h-3 w-3 rounded-full {sseConnected
                                    ? 'bg-green-400'
                                    : 'bg-amber-400 animate-pulse'}">
                                <span class="sr-only"
                                    >{sseConnected
                                        ? m.admin_connected()
                                        : m.admin_health_reconnecting()}</span>
                            </span>
                            <h3 class="text-sm font-semibold text-surface-200">
                                {m.admin_health_live_updates()}
                            </h3>
                            <span
                                class="ml-auto rounded px-1.5 py-0.5 text-xs {sseConnected
                                    ? 'bg-green-900/50 text-green-300'
                                    : 'bg-amber-900/50 text-amber-300'}">
                                {sseConnected
                                    ? m.admin_health_status_connected()
                                    : m.admin_health_status_reconnecting()}
                            </span>
                        </div>
                        <p class="mt-2 text-xs text-surface-400">
                            {sseConnected
                                ? m.admin_health_live_active()
                                : m.admin_health_live_interrupted()}
                        </p>
                    </div>
                {/if}
            </section>

            <!-- 3. Optional dependencies — unchanged; the register to copy. -->
            <section id="dependencies" class="scroll-mt-20 lg:scroll-mt-32">
                <DependencyChecksPanel />
            </section>

            <!-- 4. Provider health — reads the SAME payload field the Providers
             settings page's connectivity badges are configured from (spec
             §3.6: "Health status renders once"). -->
            <section id="providers" class="scroll-mt-20 lg:scroll-mt-32">
                {#if servicesWithVersions}
                    <ServiceHealthGrid
                        services={servicesWithVersions}
                        title={m.admin_health_section_providers()} />
                    <a
                        href={resolve('/admin/settings/connections')}
                        class="mt-2 inline-block text-xs font-medium text-sky-400 hover:text-sky-300">
                        {m.admin_health_providers_configure()}
                    </a>
                {/if}
            </section>

            <!-- 5. File health & integrity summaries — findings deep-link to the
             Media browser's file-issues filter. -->
            <section id="files" class="scroll-mt-20 lg:scroll-mt-32 space-y-2">
                <h2 class="text-sm font-semibold uppercase tracking-wide text-surface-300">
                    {m.admin_health_section_files()}
                </h2>
                {#if attentionUnavailable}
                    <p class="text-xs text-amber-300">{m.admin_ops_attention_unavailable()}</p>
                {:else if fileHealthItems.length === 0}
                    <p class="text-xs text-surface-500">{m.admin_health_files_ok()}</p>
                {:else}
                    <div class="space-y-2">
                        {#each fileHealthItems as item (item.id)}
                            <div class="card-bordered p-3 flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                    <p class="text-sm text-surface-200">{item.title}</p>
                                    {#if item.detail}
                                        <p class="mt-0.5 text-xs text-surface-400">{item.detail}</p>
                                    {/if}
                                </div>
                                {#if isHealthFilesIntegrityItem(item)}
                                    <!-- Integrity violations ARE scoped to a
                                     `media_items` row, so the media browser is
                                     the right surface for them. The file-health
                                     summary gets no link: its list is the panel
                                     directly below, on this page. -->
                                    <a
                                        href={resolve(ADMIN_MEDIA_FILE_ISSUES_PATH)}
                                        class="shrink-0 text-xs font-medium text-sky-400 hover:text-sky-300">
                                        {m.admin_health_files_view()}
                                    </a>
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/if}
                <!-- Keep results mounted after the last warning clears. -->
                <FileHealthListPanel
                    refreshKey={adminStatus.lastUpdatedAt?.getTime()}
                    onrecheck={() => adminStatus.refresh()} />
            </section>

            <!-- 6. Security self-check. -->
            <section id="security" class="scroll-mt-20 lg:scroll-mt-32">
                <SecuritySelfCheckPanel />
            </section>
        </div>
        <div hidden={activeTab !== 'history'} class="space-y-6">
            <p class="text-sm text-surface-400">{m.admin_redesign_health_history_help()}</p>
            <ChangeTimeline />
            <!-- 7. Aggregated activity log. -->
            <section id="activity" class="scroll-mt-20 lg:scroll-mt-32">
                <AuditFeed />
            </section>

            <!-- 8. Failure trends. -->
            <section id="trends" class="scroll-mt-20 lg:scroll-mt-32 space-y-4">
                <SystemicFailuresCard />
                <TrendChart />
            </section>
        </div>
    {/if}
</div>

<style>
    .health-verdict {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 1rem 1.25rem;
        border: 1px solid rgb(71 85 105 / 0.65);
        border-radius: 0.75rem;
        background: rgb(30 41 59 / 0.7);
    }
    .health-jump-nav {
        position: sticky;
        top: 0.75rem;
        z-index: 10;
        display: flex;
        gap: 0.35rem;
        overflow-x: auto;
        padding: 0.45rem;
        border: 1px solid rgb(71 85 105 / 0.5);
        border-radius: 0.65rem;
        background: rgb(15 23 42 / 0.92);
        backdrop-filter: blur(10px);
    }
    .health-jump-nav a {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        min-height: 2.5rem;
        padding: 0.35rem 0.6rem;
        border-radius: 0.4rem;
        color: rgb(148 163 184);
        font-size: 0.75rem;
        font-weight: 600;
    }
    .health-jump-nav a:hover,
    .health-jump-nav a:focus-visible {
        color: white;
        background: rgb(51 65 85 / 0.7);
    }
    .health-verdict-degraded {
        border-color: rgb(245 158 11 / 0.65);
        background: rgb(69 26 3 / 0.28);
    }
    .health-verdict-healthy {
        border-color: rgb(16 185 129 / 0.45);
        background: rgb(6 78 59 / 0.18);
    }
    .health-verdict-critical {
        border-color: rgb(239 68 68 / 0.65);
        background: rgb(127 29 29 / 0.25);
    }
    /* A check that could not complete is NOT a pass: a dashed slate-blue frame
       so it can't be skimmed past as the neutral default. */
    .health-verdict-unknown {
        border-style: dashed;
        border-color: rgb(96 165 250 / 0.6);
        background: rgb(30 58 138 / 0.18);
    }
    [hidden] {
        display: none !important;
    }
    .health-verdict-label {
        margin: 0;
        color: rgb(148 163 184);
        font-size: 0.6875rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }
    .health-verdict-title {
        margin: 0.15rem 0 0;
        color: white;
        font-size: 1.125rem;
        font-weight: 700;
    }
    .health-verdict-detail {
        margin: 0.2rem 0 0;
        color: rgb(148 163 184);
        font-size: 0.75rem;
    }
    .health-verdict-action {
        flex-shrink: 0;
        color: rgb(125 211 252);
        font-size: 0.8125rem;
        font-weight: 600;
    }
    @media (max-width: 640px) {
        .health-verdict {
            align-items: flex-start;
            flex-direction: column;
        }
    }
</style>
