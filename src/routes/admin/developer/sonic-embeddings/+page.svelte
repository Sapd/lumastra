<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { appPath } from '$lib/shared/api-urls';

    let statsTimer: ReturnType<typeof setTimeout> | undefined;
    onDestroy(() => clearTimeout(statsTimer));
    import { Icon, Sparkles } from 'svelte-hero-icons';
    import { AdminPageHeader, StatCard } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import * as m from '$lib/paraglide/messages.js';
    import type { PageData } from './$types';

    interface SonicEmbeddingsStats {
        eligibleTracks: number;
        completedTracks: number;
        pendingTracks: number;
        processingTracks: number;
        failedTracks: number;
        coveragePercent: number;
    }

    interface AnalysisCoverage {
        totalTracks: number;
        analyzedTracks: number;
    }

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    let stats = $state<SonicEmbeddingsStats | null>(null);
    let analysisCoverage = $state<AnalysisCoverage | null>(null);
    let loading = $state(true);
    let backfillLoading = $state(false);
    let mapProjectionLoading = $state(false);
    let moodVectorsLoading = $state(false);

    let analysisCoveragePercent = $derived(
        analysisCoverage && analysisCoverage.totalTracks > 0
            ? Math.round((analysisCoverage.analyzedTracks / analysisCoverage.totalTracks) * 100)
            : 0,
    );

    async function loadStats(): Promise<void> {
        loading = true;
        try {
            const response = await fetch(appPath('/admin/developer/sonic-embeddings'));
            if (!response.ok) {
                toasts.error('Failed to load sonic embeddings statistics');
                loading = false;
                return;
            }

            const data = await response.json();
            if (data.enabled && data.stats) {
                stats = data.stats;
                analysisCoverage = data.analysisCoverage ?? null;
            }
        } catch (error) {
            toasts.error(getErrorMessage(error, 'Failed to load statistics'));
        } finally {
            loading = false;
        }
    }

    async function startBackfill(): Promise<void> {
        backfillLoading = true;
        try {
            const response = await fetch(appPath('/admin/developer/sonic-embeddings'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ action: 'start-backfill' }),
            });

            if (!response.ok) {
                const error = await response.json();
                toasts.error(error.error || 'Failed to start backfill');
                return;
            }

            const result = await response.json();
            toasts.success(`Backfill task enqueued: ${result.runId}`);
            // Reload stats after a short delay
            clearTimeout(statsTimer);
            statsTimer = setTimeout(() => loadStats(), 1000);
        } catch (error) {
            toasts.error(getErrorMessage(error, 'Failed to start backfill'));
        } finally {
            backfillLoading = false;
        }
    }

    async function startMapProjection(): Promise<void> {
        mapProjectionLoading = true;
        try {
            const response = await fetch(appPath('/admin/developer/sonic-embeddings'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ action: 'start-map-projection' }),
            });

            if (!response.ok) {
                const error = await response.json();
                toasts.error(error.error || 'Failed to start map projection');
                return;
            }

            const result = await response.json();
            toasts.success(`Map projection task enqueued: ${result.runId}`);
        } catch (error) {
            toasts.error(getErrorMessage(error, 'Failed to start map projection'));
        } finally {
            mapProjectionLoading = false;
        }
    }

    async function regenerateMoodVectors(): Promise<void> {
        moodVectorsLoading = true;
        try {
            const response = await fetch(appPath('/admin/developer/sonic-embeddings'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ action: 'regenerate-mood-vectors' }),
            });

            if (!response.ok) {
                const error = await response.json();
                toasts.error(error.error || 'Failed to regenerate mood vectors');
                return;
            }

            toasts.success('Mood vectors regenerated successfully');
        } catch (error) {
            toasts.error(getErrorMessage(error, 'Failed to regenerate mood vectors'));
        } finally {
            moodVectorsLoading = false;
        }
    }

    onMount(() => {
        loadStats();
    });
</script>

<svelte:head>
    <title>Sonic Embeddings</title>
</svelte:head>

<div class="space-y-6">
    <!-- Header -->
    <AdminPageHeader
        icon={adminPageIcons['/admin/developer/sonic-embeddings']}
        title="Sonic Embeddings"
        description="Audio similarity embeddings for music tracks using MSCLAP model">
        <button
            class="btn btn-sm btn-blue flex items-center gap-2"
            onclick={loadStats}
            disabled={loading}>
            {#if loading}
                <span class="loading-spinner"></span>
            {/if}
            Refresh
        </button>
    </AdminPageHeader>

    <!-- Feature Status -->
    <div class="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
        <div class="flex items-center gap-3">
            <div class="w-3 h-3 rounded-full bg-green-500"></div>
            <div>
                <h3 class="font-medium text-white">Feature Enabled</h3>
                <p class="text-sm text-surface-400">Sonic Embeddings is currently active</p>
            </div>
        </div>
    </div>

    <!-- Statistics Grid -->
    {#if loading && !stats}
        <div class="card-base p-8">
            <div class="flex items-center gap-3 justify-center">
                <span class="loading-spinner loading-spinner-primary"></span>
                <p class="text-surface-400">Loading statistics...</p>
            </div>
        </div>
    {:else if stats}
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <!-- Total Eligible -->
            <StatCard
                icon={Sparkles}
                title="Eligible Tracks"
                color="blue"
                value={stats.eligibleTracks.toLocaleString()}
                subtitle="Music items with files" />

            <!-- Completed -->
            <StatCard
                icon={Sparkles}
                title="Completed"
                color="green"
                value={stats.completedTracks.toLocaleString()}
                healthy={true}
                subtitle="Embeddings generated" />

            <!-- Pending -->
            <StatCard
                icon={Sparkles}
                title="Pending"
                color="yellow"
                value={stats.pendingTracks.toLocaleString()}
                healthy={stats.pendingTracks === 0}
                subtitle="Awaiting processing" />

            <!-- Processing -->
            <StatCard
                icon={Sparkles}
                title="Processing"
                color="cyan"
                value={stats.processingTracks.toLocaleString()}
                subtitle="Currently in progress" />

            <!-- Failed -->
            <StatCard
                icon={Sparkles}
                title="Failed"
                color="red"
                value={stats.failedTracks.toLocaleString()}
                healthy={stats.failedTracks === 0}
                subtitle="Processing errors" />
        </div>

        <!-- Coverage Section -->
        <div class="card-base">
            <div class="mb-6">
                <h3 class="text-lg font-semibold text-white mb-2">Coverage</h3>
                <p class="text-surface-400">
                    {stats.completedTracks} of {stats.eligibleTracks} tracks have embeddings
                </p>
            </div>

            <!-- Progress Bar -->
            <div class="w-full bg-surface-700 rounded-full h-3 overflow-hidden">
                <div
                    class="bg-gradient-to-r from-blue-500 to-purple-500 h-full transition-all duration-500"
                    style={`width: ${stats.coveragePercent}%`}>
                </div>
            </div>

            <div class="mt-3 text-right">
                <span
                    class={`text-lg font-bold ${stats.coveragePercent >= 80 ? 'text-green-400' : stats.coveragePercent >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                    {stats.coveragePercent}%
                </span>
            </div>
        </div>

        <!-- Essentia Analysis Coverage -->
        {#if analysisCoverage}
            <div class="card-base">
                <div class="mb-6">
                    <h3 class="text-lg font-semibold text-white mb-2">
                        Essentia Analysis Coverage
                    </h3>
                    <p class="text-surface-400">
                        {analysisCoverage.analyzedTracks.toLocaleString()} of {analysisCoverage.totalTracks.toLocaleString()}
                        tracks have BPM / key / mood data from Essentia analysis
                    </p>
                </div>

                <!-- Progress Bar -->
                <div class="w-full bg-surface-700 rounded-full h-3 overflow-hidden">
                    <div
                        class="bg-gradient-to-r from-green-500 to-teal-500 h-full transition-all duration-500"
                        style={`width: ${analysisCoveragePercent}%`}>
                    </div>
                </div>

                <div class="mt-3 text-right">
                    <span
                        class={`text-lg font-bold ${analysisCoveragePercent >= 80 ? 'text-green-400' : analysisCoveragePercent >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {analysisCoveragePercent}%
                    </span>
                </div>
            </div>
        {/if}

        <!-- Status Breakdown -->
        <div class="card-base">
            <h3 class="text-lg font-semibold text-white mb-4">Status Breakdown</h3>
            <div class="space-y-3">
                <div class="flex items-center justify-between py-2 border-b border-surface-700/50">
                    <span class="text-surface-300">Done</span>
                    <span class="font-mono text-green-400"
                        >{stats.completedTracks.toLocaleString()}</span>
                </div>
                <div class="flex items-center justify-between py-2 border-b border-surface-700/50">
                    <span class="text-surface-300">Pending</span>
                    <span class="font-mono text-yellow-400"
                        >{stats.pendingTracks.toLocaleString()}</span>
                </div>
                <div class="flex items-center justify-between py-2 border-b border-surface-700/50">
                    <span class="text-surface-300">Processing</span>
                    <span class="font-mono text-blue-400"
                        >{stats.processingTracks.toLocaleString()}</span>
                </div>
                <div class="flex items-center justify-between py-2">
                    <span class="text-surface-300">Failed</span>
                    <span class="font-mono text-red-400"
                        >{stats.failedTracks.toLocaleString()}</span>
                </div>
            </div>
        </div>

        <!-- Actions -->
        <div class="card-base">
            <h3 class="text-lg font-semibold text-white mb-4">Backfill Task</h3>
            <p class="text-surface-400 mb-4">
                Start the audio embedding backfill task to generate embeddings for all eligible
                music tracks. This task runs with concurrency = 1 on a dedicated GPU resource class.
            </p>
            <button
                class="btn btn-lg btn-primary flex items-center gap-2"
                onclick={startBackfill}
                disabled={backfillLoading || loading}>
                {#if backfillLoading}
                    <span class="loading-spinner"></span>
                {:else}
                    <Icon src={Sparkles} class="w-5 h-5" />
                {/if}
                Start Backfill
            </button>
        </div>

        <!-- Map Projection -->
        <div class="card-base">
            <h3 class="text-lg font-semibold text-white mb-4">Music Map Projection</h3>
            <p class="text-surface-400 mb-4">
                Compute the 2D UMAP projection of the audio embeddings that powers the interactive
                Music Map. Run this after the backfill has generated embeddings; the map appears on
                /music/map once the projection finishes.
            </p>
            <button
                class="btn btn-lg btn-primary flex items-center gap-2"
                onclick={startMapProjection}
                disabled={mapProjectionLoading || loading}>
                {#if mapProjectionLoading}
                    <span class="loading-spinner"></span>
                {:else}
                    <Icon src={Sparkles} class="w-5 h-5" />
                {/if}
                Compute Music Map Projection
            </button>
        </div>

        <!-- Mood Vectors -->
        <div class="card-base">
            <h3 class="text-lg font-semibold text-white mb-4">Music Mood Vectors</h3>
            <p class="text-surface-400 mb-4">
                Regenerate mood direction vectors by averaging track embeddings per mood seed. These
                vectors power the mood-recommendation rows (text-space similarity). Run this after a
                sonic embedding backfill completes to populate or refresh mood targeting.
            </p>
            <button
                class="btn btn-lg btn-secondary flex items-center gap-2"
                onclick={regenerateMoodVectors}
                disabled={moodVectorsLoading || loading}>
                {#if moodVectorsLoading}
                    <span class="loading-spinner"></span>
                {:else}
                    <Icon src={Sparkles} class="w-5 h-5" />
                {/if}
                Regenerate Mood Vectors
            </button>
        </div>

        <!-- Information -->
        <div class="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
            <h4 class="font-semibold text-white mb-3">How it works</h4>
            <ul class="space-y-2 text-sm text-surface-300">
                <li>• Eligible tracks: all music items with at least one media file</li>
                <li>• Model: MSCLAP 2023 (1024-dimensional embeddings)</li>
                <li>• Backfill runs on a dedicated GPU resource class with concurrency = 1</li>
                <li>• Embeddings enable audio-based similarity search</li>
                <li>• Task is manual-start only (no automatic scheduling)</li>
            </ul>
        </div>
    {/if}
</div>

<!-- card-base is a global utility (src/lib/styles/global-components.css); no local redefinition needed -->
