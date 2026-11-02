<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { Users, Film, CpuChip, ArrowPath, Icon } from 'svelte-hero-icons';
    import { AdminPageHeader, StatCard } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { resolve } from '$lib/paths';
    import { adminStatus } from '$lib/stores/admin-status.store.svelte.js';
    import { formatAgo, formatBytes, formatCheckedAgo } from '$lib/utils/admin/formatters';
    import AttentionList from '$lib/components/admin/attention/AttentionList.svelte';
    import VerdictBanner from '$lib/components/admin/attention/VerdictBanner.svelte';
    import NowPlayingStrip from '$lib/components/admin/NowPlayingStrip.svelte';
    import NowWatchingTile from '$lib/components/admin/NowWatchingTile.svelte';
    import ClusterGlanceTile from '$lib/components/admin/ClusterGlanceTile.svelte';
    import LoadControls from '$lib/components/admin/LoadControls.svelte';
    import NightlyDigest from '$lib/components/admin/NightlyDigest.svelte';
    import LibraryGrowthSparkline from '$lib/components/admin/LibraryGrowthSparkline.svelte';
    import LibraryProcessingHero from '$lib/components/admin/LibraryProcessingHero.svelte';
    import SetupChecklist from '$lib/components/admin/SetupChecklist.svelte';
    import AdminHomeSearchBar from '$lib/components/admin/AdminHomeSearchBar.svelte';
    import { visibleNav } from '$lib/config/admin-nav';
    import { isInputFocused } from '$lib/utils/admin/settings-search';
    import type { PageData } from './$types';

    /**
     * Admin Home — triage, not content (spec §3.1). Every element answers "do I
     * need to do something?" or is a doorway. It makes NO fetches of its own
     * (one exception below): it reads only the ONE canonical status payload
     * (`adminStatus`, the poller the /admin layout owns), so its verdict,
     * attention list and counters can never disagree with the bell or Health.
     * The exception: the library growth sparkline loads its own decorative
     * trend once on mount; it never feeds the verdict and renders nothing when
     * it has no data. Deliberately absent: services grid,
     * embeddings coverage, charts, task tables, run feeds (those live on Health).
     */

    interface Props {
        data: PageData;
    }
    let { data }: Props = $props();

    // Same derivation `+layout.svelte` uses to build AdminCommandPalette's
    // navSections — called again here (not shared state) since this page has no
    // access to the layout's local `sections` variable.
    const trainingAssignments = $derived(data?.features?.trainingAssignments === true);
    const assessment = $derived(data?.features?.assessment === true);
    const showcase = $derived(data?.features?.showcase === true);
    const devToolsEnabled = $derived(data?.devToolsEnabled === true);
    const navGate = $derived({
        devToolsEnabled,
        features: data?.features ?? {},
        trainingAssignments,
        assessment,
        showcase,
    });
    const navSections = $derived(visibleNav(navGate));
    const providerIndex = $derived(data?.providerIndex ?? []);
    const devFeaturesEnabled = $derived(data?.devFeaturesEnabled === true);

    let searchBarRef: AdminHomeSearchBar | null = $state(null);

    function handleHomeKeydown(event: KeyboardEvent): void {
        if (event.key === '/' && !isInputFocused()) {
            event.preventDefault();
            searchBarRef?.focusAndExpand();
        }
    }

    // The one source of truth. AttentionList (always mounted below) ref-counts
    // the poller start/stop, so Home never has to.
    const payload = $derived(adminStatus.payload);

    // First-run: until the first library scan lands any media, sections 3–5 are
    // replaced by the setup checklist. Kept as ONE derived so it stays adjustable.
    // Zero items only means "first run" while the database answered: a failed
    // count makes the status report the database unhealthy, and that must not
    // swap Now Playing and Processing out for the checklist.
    const isFirstRun = $derived(
        (payload?.library.totalItems ?? 0) === 0 && payload?.system.databaseHealthy !== false,
    );

    // Open (actionable) attention items — the ones the verdict counts and the
    // list shows. Acked/snoozed items are quiet.
    const openItems = $derived(
        (payload?.attention.items ?? []).filter(
            (i) => !i.acked && !i.snoozed && i.severity !== 'info',
        ),
    );
    const worstTitle = $derived(
        openItems.find((i) => i.severity === 'critical')?.title ??
            openItems.find((i) => i.severity === 'warning')?.title ??
            openItems[0]?.title,
    );

    // Same ranking as worstTitle, but the whole item — NightlyDigest's "one
    // thing needs you" line reuses this rather than querying attention a
    // second time, so it can never disagree with the banner/bell above.
    const topAttentionItem = $derived(
        openItems.find((i) => i.severity === 'critical') ??
            openItems.find((i) => i.severity === 'warning') ??
            openItems[0] ??
            null,
    );

    // Healthy-state live fact, composed from payload counters (spec §3.1).
    const greenFact = $derived.by((): string | undefined => {
        if (!payload) return undefined;
        const parts = [m.admin_home_fact_tasks_ran({ count: payload.tasks.ranToday })];
        if (payload.library.totalItems > 0) {
            parts.push(m.admin_home_fact_library_items({ count: payload.library.totalItems }));
        }
        return parts.join(' · ');
    });

    const librarySize = $derived(
        payload?.library.totalSizeBytes !== undefined
            ? formatBytes(payload.library.totalSizeBytes)
            : undefined,
    );

    // Section landings for stat-strip / show-all links.
    const HEALTH_HREF = '/admin/system/health';
    const SESSIONS_HREF = '/admin/users/sessions';
    const USERS_HREF = '/admin/users';
    const LIBRARY_HREF = '/admin/library/media';
    const TASKS_HREF = '/admin/tasks';
    const CLUSTER_HREF = '/admin/system/health?tab=cluster';

    function scrollToAttention(): void {
        document
            .getElementById('needs-attention')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
</script>

<svelte:head><title>{m.admin_nav_page_home()} · {m.admin_title()}</title></svelte:head>
<svelte:window onkeydown={handleHomeKeydown} />
<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin']}
        title={m.admin_system_status()}
        description={m.admin_redesign_home_description()}>
        <button
            class="btn btn-surface"
            disabled={adminStatus.loading}
            onclick={() => void adminStatus.refresh()}>
            <Icon src={ArrowPath} class="h-4 w-4" />{m.common_refresh()}
        </button>
        <a class="btn btn-surface" href={resolve(HEALTH_HREF)}>{m.admin_health_title()} →</a>
    </AdminPageHeader>

    <AdminHomeSearchBar
        {navSections}
        {navGate}
        {providerIndex}
        {devFeaturesEnabled}
        bind:this={searchBarRef} />

    {#if adminStatus.loading && !payload}
        <div
            class="rounded-xl border border-surface-700 bg-surface-800/40 p-10 text-center"
            role="status">
            <p class="text-surface-400">{m.loading_default()}</p>
        </div>
    {:else if !payload}
        <div class="section-error text-center" role="alert">
            <p class="text-red-300">{m.admin_failed_load_status()}</p>
            <button class="btn btn-surface mt-3" onclick={() => void adminStatus.refresh()}
                >{m.btn_retry()}</button>
        </div>
    {:else}
        {#if adminStatus.error && adminStatus.lastUpdatedAt}
            <!-- The last poll failed: everything below is the previous answer. -->
            <div
                class="section-error flex flex-wrap items-center justify-between gap-2"
                role="alert">
                <p class="text-red-300">
                    {m.admin_failed_load_status()} · {formatCheckedAgo(
                        adminStatus.lastUpdatedAt.toISOString(),
                    )}
                </p>
                <button class="btn btn-surface" onclick={() => void adminStatus.refresh()}
                    >{m.btn_retry()}</button>
            </div>
        {/if}
        <VerdictBanner
            verdict={payload.verdict}
            attentionCount={openItems.length}
            {worstTitle}
            {greenFact}
            generatedAt={payload.generatedAt}
            unavailable={payload.attention.unavailable ?? false}
            onScrollToList={scrollToAttention} />

        <section
            id="overview"
            class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*>*]:h-full"
            aria-label={m.admin_redesign_home_live()}>
            <NowWatchingTile
                count={payload.sessions.count}
                preview={payload.sessions.preview}
                sessionsHref={SESSIONS_HREF}
                load={payload.sessions.load}
                lastEnded={payload.sessions.lastEnded}
                formatAgo={(iso) => formatAgo(Date.now() - Date.parse(iso))} />
            <a
                class="rounded-lg focus-visible:outline-2 focus-visible:outline-primary-400 hover:opacity-90"
                href={resolve(TASKS_HREF)}>
                <StatCard
                    icon={CpuChip}
                    title={m.admin_home_stat_tasks()}
                    value={payload.tasks.running.toLocaleString()}
                    subtitle={m.admin_home_stat_running_label()}
                    color="cyan" />
            </a>
            <!-- The growth chart is interactive, so it must not sit inside the link:
                 the anchor is a stretched link over the card, the chart sits above it. -->
            <div class="relative rounded-xl has-[a:hover]:opacity-90">
                <StatCard
                    icon={Film}
                    title={m.admin_home_stat_library()}
                    value={payload.library.totalItems.toLocaleString()}
                    subtitle={librarySize ?? m.admin_home_stat_library()}
                    color="blue">
                    <div class="relative z-10"><LibraryGrowthSparkline /></div>
                </StatCard>
                <a
                    class="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-primary-400"
                    href={resolve(LIBRARY_HREF)}
                    aria-label={[
                        m.admin_home_stat_library(),
                        payload.library.totalItems.toLocaleString(),
                        librarySize,
                    ]
                        .filter(Boolean)
                        .join(' · ')}></a>
            </div>
            <a
                class="rounded-lg focus-visible:outline-2 focus-visible:outline-primary-400 hover:opacity-90"
                href={resolve(USERS_HREF)}>
                <StatCard
                    icon={Users}
                    title={m.admin_users()}
                    value={payload.users.total.toLocaleString()}
                    subtitle={m.admin_registered_accounts()}
                    color="purple">
                    {#if payload.users.active30d !== undefined}
                        <div class="mt-4 border-t border-surface-700/60 pt-3">
                            <p class="text-xl font-semibold tabular-nums text-purple-400">
                                {payload.users.active30d.toLocaleString()}
                            </p>
                            <p class="text-caption mt-1">
                                {m.admin_stats_active_users()} · {m.admin_stats_last_30_days()}
                            </p>
                        </div>
                    {/if}
                </StatCard>
            </a>
            <ClusterGlanceTile glance={payload.cluster} href={CLUSTER_HREF} />
        </section>

        <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <section
                id="needs-attention"
                class="min-w-0 scroll-mt-20 rounded-xl border border-surface-700 bg-surface-800/30 p-4 sm:p-5">
                <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 class="text-base font-semibold text-white">
                            {m.admin_ops_attention_heading()}
                        </h2>
                        <p class="mt-1 text-sm text-surface-400">
                            {m.admin_redesign_home_attention_hint()}
                        </p>
                    </div>
                    <a class="text-sm text-primary-300 hover:underline" href={resolve(HEALTH_HREF)}
                        >{m.admin_redesign_home_investigate()} →</a>
                </div>
                <AttentionList
                    actionableOnly
                    showVerdict={false}
                    max={5}
                    showAllHref={HEALTH_HREF} />
            </section>
            <div class="flex min-w-0 flex-col gap-6">
                <section id="activity" class="min-w-0 scroll-mt-20">
                    <NightlyDigest attentionItem={topAttentionItem} />
                </section>
                {#if !isFirstRun}
                    <section id="now-playing" class="min-w-0 scroll-mt-20">
                        <NowPlayingStrip
                            count={payload.sessions.count}
                            preview={payload.sessions.preview}
                            sessionsHref={SESSIONS_HREF} />
                    </section>
                    <section id="processing" class="min-w-0 scroll-mt-20">
                        <LibraryProcessingHero />
                    </section>
                {/if}
            </div>
        </div>

        {#if isFirstRun}
            <SetupChecklist />
        {/if}

        <details class="rounded-xl border border-surface-700 bg-surface-800/20">
            <summary class="cursor-pointer px-5 py-4 text-sm font-medium text-surface-200">
                {m.admin_redesign_home_controls()}
                <span class="ml-2 font-normal text-surface-400"
                    >{m.admin_redesign_home_controls_hint()}</span>
            </summary>
            <div class="border-t border-surface-700 p-4 sm:p-5"><LoadControls /></div>
        </details>
    {/if}
</div>
