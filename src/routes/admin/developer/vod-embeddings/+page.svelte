<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { appPath } from '$lib/shared/api-urls';

    let statsTimer: ReturnType<typeof setTimeout> | undefined;
    onDestroy(() => clearTimeout(statsTimer));
    import { Film, Sparkles, CircleStack } from 'svelte-hero-icons';
    import CoverageDashboard from '$lib/components/admin/CoverageDashboard.svelte';
    import type {
        CoverageStat,
        CoverageBar,
        CoverageStatusRow,
        CoverageAction,
    } from '$lib/components/admin/CoverageDashboard.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';

    interface VodCoverage {
        eligible: number;
        withEmbedding: number;
        withLibrary: number;
        withDiscovery: number;
        withBoth: number;
        missing: number;
        coveragePercent: number;
    }

    let coverage = $state<VodCoverage | null>(null);
    let loading = $state(true);
    let libraryLoading = $state(false);
    let discoveryLoading = $state(false);

    async function loadStats(): Promise<void> {
        loading = true;
        try {
            const response = await fetch(appPath('/admin/developer/vod-embeddings'));
            if (!response.ok) {
                toasts.error('Failed to load VOD embedding coverage');
                return;
            }
            const data = await response.json();
            if (data.enabled && data.coverage) {
                coverage = data.coverage;
            }
        } catch (error) {
            toasts.error(getErrorMessage(error, 'Failed to load coverage'));
        } finally {
            loading = false;
        }
    }

    async function runAction(action: string, setLoading: (v: boolean) => void): Promise<void> {
        setLoading(true);
        try {
            const response = await fetch(appPath('/admin/developer/vod-embeddings'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                toasts.error(error.error || 'Failed to start task');
                return;
            }
            const result = await response.json();
            toasts.success(`Task enqueued: ${result.runId}`);
            clearTimeout(statsTimer);
            statsTimer = setTimeout(() => loadStats(), 1000);
        } catch (error) {
            toasts.error(getErrorMessage(error, 'Failed to start task'));
        } finally {
            setLoading(false);
        }
    }

    let stats = $derived<CoverageStat[]>(
        coverage
            ? [
                  {
                      title: 'Eligible',
                      value: coverage.eligible,
                      icon: Film,
                      color: 'blue',
                      subtitle: 'Active movies & TV',
                  },
                  {
                      title: 'With Embeddings',
                      value: coverage.withEmbedding,
                      icon: Sparkles,
                      color: 'green',
                      healthy: true,
                      subtitle: 'Library or discovery',
                  },
                  {
                      title: 'Library',
                      value: coverage.withLibrary,
                      icon: CircleStack,
                      color: 'cyan',
                      subtitle: 'Owned items',
                  },
                  {
                      title: 'Discovery',
                      value: coverage.withDiscovery,
                      icon: Sparkles,
                      color: 'purple',
                      subtitle: 'Catalog-only items',
                  },
                  {
                      title: 'Missing',
                      value: coverage.missing,
                      icon: Film,
                      color: 'yellow',
                      healthy: coverage.missing === 0,
                      subtitle: 'No embedding yet',
                  },
              ]
            : [],
    );

    let coverageBars = $derived<CoverageBar[]>(
        coverage
            ? [
                  {
                      label: 'Coverage',
                      description: `${coverage.withEmbedding.toLocaleString()} of ${coverage.eligible.toLocaleString()} movies & TV have AI embeddings`,
                      percent: coverage.coveragePercent,
                  },
              ]
            : [],
    );

    let statusBreakdown = $derived<CoverageStatusRow[]>(
        coverage
            ? [
                  {
                      label: 'With embedding',
                      value: coverage.withEmbedding,
                      colorClass: 'text-green-400',
                  },
                  {
                      label: 'Library source',
                      value: coverage.withLibrary,
                      colorClass: 'text-cyan-400',
                  },
                  {
                      label: 'Discovery source',
                      value: coverage.withDiscovery,
                      colorClass: 'text-purple-400',
                  },
                  { label: 'Missing', value: coverage.missing, colorClass: 'text-yellow-400' },
              ]
            : [],
    );

    let actions = $derived<CoverageAction[]>([
        {
            id: 'start-library-backfill',
            label: 'Generate Library Embeddings',
            description:
                'Embed owned movie/TV items (those with files). Drains the library-embeddings backlog.',
            variant: 'primary',
            loading: libraryLoading,
            onclick: () => runAction('start-library-backfill', (v) => (libraryLoading = v)),
        },
        {
            id: 'start-discovery-backfill',
            label: 'Generate Discovery Embeddings',
            description:
                'Embed catalog-only movie/TV items (no local files) used for Trending / For-You discovery.',
            variant: 'secondary',
            loading: discoveryLoading,
            onclick: () => runAction('start-discovery-backfill', (v) => (discoveryLoading = v)),
        },
    ]);

    onMount(() => {
        loadStats();
    });
</script>

<svelte:head>
    <title>VOD Embeddings</title>
</svelte:head>

<CoverageDashboard
    title="VOD Embeddings"
    description="AI text embeddings for movies & TV — powering semantic search and For-You recommendations"
    icon={Film}
    {loading}
    {stats}
    {coverageBars}
    {statusBreakdown}
    {actions}
    infoItems={[
        'Eligible: all active movie & TV catalog items',
        'Library embeddings cover owned items (with files); discovery embeddings cover catalog-only items',
        'The two sources are mutually exclusive by has_files — together they describe whole-catalog AI readiness',
        'Library runs every 15m, discovery every 6h; the buttons above force an immediate backfill pass',
    ]}
    onRefresh={loadStats} />
