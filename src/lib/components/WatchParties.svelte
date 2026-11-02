<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { isAuthFailed } from '$lib/auth-monitor';
    import type { WatchTogetherParty } from '$lib/types/watch-together';
    import type { PublicParty } from '$lib/api/watch-together';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import * as watchTogetherApi from '$lib/api/watch-together';
    import { isEpisode } from '$lib/shared/media-types';
    import { page } from '$app/stores';
    import { CLIENT_TUNING_DEFAULTS } from '$lib/stores/client-tuning';

    interface Props {
        userId: string;
        onvisibilityChange?: (detail: { visible: boolean }) => void;
    }

    let { userId, onvisibilityChange }: Props = $props();

    let sessions: PublicParty[] = $state([]);
    let loading = $state(true);
    let currentSession = $state<WatchTogetherParty | null>(null);
    let error: string | null = null;
    let refreshInterval: ReturnType<typeof setInterval>;
    let wasVisible = false;

    async function loadSessions() {
        if (isAuthFailed()) {
            // Session expired: stop the refresh loop instead of 401-ing forever.
            if (refreshInterval) clearInterval(refreshInterval);
            loading = false;
            return;
        }
        try {
            const { data, error: apiError } = await watchTogetherApi.getPublicParties();
            if (apiError) throw new Error(apiError);
            sessions = data?.items ?? [];
            const current = await watchTogetherApi.getCurrentSession();
            currentSession = current.data?.party ?? null;
            error = null;
        } catch (err) {
            console.error('[WatchParties] Load error:', err);
            error = 'Failed to load watch parties';
        } finally {
            loading = false;
            // Dispatch visibility change when data loads
            const isVisible = sessions.length > 0;
            if (isVisible !== wasVisible) {
                wasVisible = isVisible;
                onvisibilityChange?.({ visible: isVisible });
            }
        }
    }

    async function joinParty(session: PublicParty) {
        // Navigate to the party page which loads full session details server-side
        // and lets the user choose their device or join in-browser.
        goto(resolve(`/party/${session.code}`));
    }

    async function disbandParty(event: MouseEvent, session: PublicParty) {
        event.stopPropagation(); // Prevent triggering joinParty

        if (
            !confirm(
                `End watch party for "${session.title}"? All participants will be disconnected.`,
            )
        ) {
            return;
        }

        try {
            const { error: apiError } = await watchTogetherApi.deleteSession(session.code);

            if (apiError) {
                throw new Error(apiError);
            }

            // Refresh the list
            await loadSessions();
        } catch (err) {
            console.error('[WatchParties] Disband error:', err);
            alert(err instanceof Error ? err.message : 'Failed to end party');
        }
    }

    function formatDuration(startTime: number): string {
        const minutes = Math.floor((Date.now() - startTime) / 60000);
        if (minutes < 1) return 'Just started';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m ago`;
    }

    onMount(() => {
        loadSessions();
        // Refresh on the configured cadence (WATCH_PARTIES_REFRESH_MS,
        // default 15s) — skip ticks while the tab is hidden so we aren't
        // refetching the participant list nobody is looking at.
        //
        // Read off page data rather than the hydrated module: this runs at
        // mount, and the layout's hydration $effect is not guaranteed to have
        // flushed by then. Page data is populated synchronously, so it is
        // correct on the very first load. A cadence change applies on the next
        // page load.
        refreshInterval = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return;
            loadSessions();
        }, $page.data.clientTuning?.partiesRefreshMs ?? CLIENT_TUNING_DEFAULTS.partiesRefreshMs);
    });

    onDestroy(() => {
        if (refreshInterval) clearInterval(refreshInterval);
    });
</script>

{#if loading}
    <div class="watch-parties-loading">
        <div class="spinner"></div>
    </div>
{:else if sessions.length > 0}
    <section class="watch-parties">
        <h2 class="section-title">
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                class="title-icon">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Watch Parties
        </h2>

        <div class="parties-grid">
            {#each sessions as session (session.code)}
                <div
                    class="party-card"
                    role="button"
                    tabindex="0"
                    onclick={() => joinParty(session)}
                    onkeydown={(e) => e.key === 'Enter' && joinParty(session)}>
                    <div class="party-poster">
                        <div class="party-poster-placeholder" aria-hidden="true">
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.5">
                                <rect x="2" y="3" width="20" height="14" rx="2" />
                                <path d="M8 21h8M12 17v4" />
                            </svg>
                        </div>
                        <div class="party-badge">
                            <span class="live-dot"></span>
                            LIVE
                        </div>
                    </div>

                    <div class="party-info">
                        <h3 class="party-title">{session.title}</h3>
                        <p class="party-meta">
                            {isEpisode(session.mediaType) ? 'TV Show' : 'Movie'}
                            <span class="dot">•</span>
                            {formatDuration(session.createdAt)}
                        </p>

                        <div class="party-participants">
                            <span class="participant-count">
                                {session.participantCount}
                                {session.participantCount === 1 ? 'viewer' : 'viewers'}
                            </span>
                        </div>
                    </div>

                    {#if currentSession?.code === session.code && currentSession?.host.userId === userId}
                        <Tooltip text="End this watch party" position="left" fixed>
                            <button
                                class="disband-button"
                                aria-label="End this watch party"
                                onclick={(e) => disbandParty(e, session)}>
                                <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            </button>
                        </Tooltip>
                    {:else}
                        <div class="join-arrow">
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2">
                                <path d="M9 18l6-6-6-6" />
                            </svg>
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    </section>
{/if}

<style>
    .watch-parties {
        margin-bottom: 2rem;
    }

    .section-title {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 1.25rem;
        font-weight: 600;
        color: white;
        margin-bottom: 1rem;
    }

    .title-icon {
        width: 24px;
        height: 24px;
        color: #8b5cf6;
    }

    .parties-grid {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .party-card {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.75rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.2s;
        text-align: left;
        width: 100%;
    }

    .party-card:hover {
        background: rgba(139, 92, 246, 0.15);
        border-color: rgba(139, 92, 246, 0.3);
        transform: translateX(4px);
    }

    .party-poster {
        position: relative;
        width: 60px;
        height: 90px;
        border-radius: 8px;
        overflow: hidden;
        flex-shrink: 0;
    }

    .party-poster-placeholder {
        width: 100%;
        height: 100%;
        background: rgba(139, 92, 246, 0.12);
        display: flex;
        align-items: center;
        justify-content: center;
        color: rgba(139, 92, 246, 0.5);
    }

    .party-poster-placeholder svg {
        width: 32px;
        height: 32px;
    }

    .party-badge {
        position: absolute;
        top: 4px;
        left: 4px;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        background: rgba(239, 68, 68, 0.9);
        border-radius: 4px;
        font-size: 0.6rem;
        font-weight: 700;
        color: white;
        text-transform: uppercase;
    }

    .live-dot {
        width: 6px;
        height: 6px;
        background: white;
        border-radius: 50%;
        animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.5;
        }
    }

    .party-info {
        flex: 1;
        min-width: 0;
    }

    .party-title {
        font-size: 0.95rem;
        font-weight: 500;
        color: white;
        margin: 0 0 0.25rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .party-meta {
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.5);
        margin: 0 0 0.5rem;
    }

    .dot {
        margin: 0 0.25rem;
    }

    .party-participants {
        display: flex;
        align-items: center;
    }

    .participant-count {
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.5);
    }

    .join-arrow {
        flex-shrink: 0;
        width: 24px;
        height: 24px;
        color: rgba(255, 255, 255, 0.3);
        transition: all 0.2s;
    }

    .party-card:hover .join-arrow {
        color: #8b5cf6;
        transform: translateX(4px);
    }

    .disband-button {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        padding: 6px;
        border-radius: 8px;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.2);
        color: rgba(239, 68, 68, 0.6);
        cursor: pointer;
        transition: all 0.2s;
    }

    .disband-button:hover {
        background: rgba(239, 68, 68, 0.2);
        border-color: rgba(239, 68, 68, 0.4);
        color: #ef4444;
    }

    .watch-parties-loading {
        display: flex;
        justify-content: center;
        padding: 2rem;
    }

    .spinner {
        width: 24px;
        height: 24px;
        border: 2px solid rgba(255, 255, 255, 0.1);
        border-top-color: #8b5cf6;
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
