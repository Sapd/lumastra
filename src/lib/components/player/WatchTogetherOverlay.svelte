<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';
    import { playerStore } from './playerStore.svelte';
    import type { PublicParty } from '$lib/types/api-watch-together';
    import * as watchTogetherApi from '$lib/api/watch-together';
    import SyncStatusIndicator from './SyncStatusIndicator.svelte';
    import { watchPartySyncPin } from './watch-party-sync-pin.svelte';

    interface Props {
        itemId: string;
        mediaType: 'movie' | 'episode' | 'tv' | 'series' | 'tvchannel';
        title: string;
        userId: string;
        fileId?: string | undefined;
        isOpen: boolean;
    }

    let { itemId, mediaType, title, userId, fileId = undefined, isOpen }: Props = $props();

    let isCreating = $state(false);
    let listPublicly = $state(false);
    let isLeaving = $state(false);
    let isJoining = $state(false);
    let isDisbanding = $state(false);
    let isTransferring = $state(false);
    let isTogglingVisibility = $state(false);
    // 'sessions' shows public session list; 'code' shows code input; null shows main menu
    let joinMode = $state<'sessions' | 'code' | null>(null);
    let showTransferMenu = $state(false);
    let joinCode = $state('');
    let joinError = $state('');
    let copiedLink = $state(false);

    // Public sessions
    let publicSessions: PublicParty[] = $state([]);
    let isLoadingSessions = $state(false);
    let joiningSessionCode = $state<string | null>(null);

    // Reset transient UI state when the panel closes
    $effect(() => {
        if (!isOpen) {
            listPublicly = false;
            joinMode = null;
            joinCode = '';
            joinError = '';
            publicSessions = [];
            showTransferMenu = false;
            joiningSessionCode = null;
            copiedLink = false;
        }
    });

    // Fetch public sessions when join panel opens
    async function fetchPublicParties() {
        if (isLoadingSessions) return;
        isLoadingSessions = true;
        try {
            const { data, error: sessionsError } = await watchTogetherApi.getPublicParties();
            if (!sessionsError && data) {
                const sessions = data.items ?? [];
                // Filter out sessions we're already in and our own potential sessions
                publicSessions = sessions.filter((s) => s.code !== watchTogether.session?.code);
            }
        } catch (err) {
            console.error('[WatchTogether] Failed to fetch sessions:', err);
        } finally {
            isLoadingSessions = false;
        }
    }

    // Join a public session directly
    async function handleJoinPublicParty(session: PublicParty) {
        if (isJoining || joiningSessionCode) return;

        joiningSessionCode = session.code;
        joinError = '';

        try {
            const joinedSession = await watchTogether.joinSession(session.code, userId);

            if (!joinedSession) {
                joinError = 'Session no longer available';
                joiningSessionCode = null;
                // Refresh the list
                fetchPublicParties();
                return;
            }

            // If the session's item is different from current video, redirect
            if (joinedSession.itemId !== itemId) {
                const url = joinedSession.fileId
                    ? `/watch/${joinedSession.itemId}?fileId=${joinedSession.fileId}`
                    : `/watch/${joinedSession.itemId}`;
                await goto(resolve(url));
            } else if (joinedSession.fileId && joinedSession.fileId !== fileId) {
                const url = `/watch/${joinedSession.itemId}?fileId=${joinedSession.fileId}`;
                await goto(resolve(url));
            }

            joinMode = null;
            publicSessions = [];
        } catch (err) {
            console.error('[WatchTogether] Join error:', err);
            joinError = err instanceof Error ? err.message : 'Failed to join';
        } finally {
            joiningSessionCode = null;
        }
    }

    // Get unique participants (dedupe by userId for transfer menu)
    let uniqueParticipants = $derived(
        watchTogether.watchPartyParticipants.reduce(
            (acc, p) => {
                if (!acc.some((existing) => existing.userId === p.userId)) {
                    acc.push(p);
                }
                return acc;
            },
            [] as typeof watchTogether.watchPartyParticipants,
        ),
    );

    // Get guests only (exclude host) for transfer menu
    let guests = $derived(
        uniqueParticipants.filter((p) => p.userId !== watchTogether.session?.host.userId),
    );

    // Create a new session
    async function handleCreateSession() {
        isCreating = true;
        try {
            // Pass current playback time and media source so session starts at host's position and version
            const currentTime = playerStore.currentTime || 0;
            await watchTogether.createSession(
                itemId,
                mediaType.toLowerCase() as 'movie' | 'episode' | 'tv' | 'series',
                title,
                userId,
                undefined,
                currentTime,
                fileId,
                listPublicly ? 'listed' : 'unlisted',
            );
        } finally {
            isCreating = false;
        }
    }

    // Join a session by code
    async function handleJoinSession() {
        if (!joinCode.trim() || isJoining) return;

        isJoining = true;
        joinError = '';

        try {
            const session = await watchTogether.joinSession(joinCode.trim(), userId);

            if (!session) {
                joinError = 'Session not found';
                return;
            }

            // If the session's item is different from current video, redirect
            if (session.itemId !== itemId) {
                console.log('[WatchTogether] Session is for different item, redirecting...', {
                    currentItemId: itemId,
                    sessionItemId: session.itemId,
                    sessionTitle: session.title,
                    sessionFileId: session.fileId,
                });
                // Navigate to the session's video with fileId if present
                const url = session.fileId
                    ? `/watch/${session.itemId}?fileId=${session.fileId}`
                    : `/watch/${session.itemId}`;
                await goto(resolve(url));
            } else if (session.fileId && session.fileId !== fileId) {
                // Same item but different file - redirect to sync version
                console.log('[WatchTogether] Session has different file, redirecting...', {
                    currentFileId: fileId,
                    sessionFileId: session.fileId,
                });
                const url = `/watch/${session.itemId}?fileId=${session.fileId}`;
                await goto(resolve(url));
            }

            // Clear input and hide
            joinCode = '';
            joinMode = null;
        } catch (err) {
            console.error('[WatchTogether] Join error:', err);
            joinError = err instanceof Error ? err.message : 'Failed to join';
        } finally {
            isJoining = false;
        }
    }

    // Handle Enter key in join input
    function handleJoinKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            handleJoinSession();
        } else if (event.key === 'Escape') {
            joinMode = null;
            joinCode = '';
            joinError = '';
        }
    }

    // Leave session
    async function handleLeaveSession() {
        if (isLeaving) return;
        isLeaving = true;
        console.log('[WatchTogether] Leave button clicked');
        try {
            await watchTogether.leaveSession();
            console.log('[WatchTogether] Left session successfully');
        } catch (err) {
            console.error('[WatchTogether] Leave error:', err);
        } finally {
            isLeaving = false;
        }
    }

    // Disband session (host only)
    async function handleDisbandSession() {
        if (isDisbanding) return;
        isDisbanding = true;
        console.log('[WatchTogether] Disband button clicked');
        try {
            await watchTogether.disbandSession();
            console.log('[WatchTogether] Session disbanded successfully');
        } catch (err) {
            console.error('[WatchTogether] Disband error:', err);
        } finally {
            isDisbanding = false;
        }
    }

    // Transfer host to another participant
    async function handleTransferHost(newHostUserId: string) {
        if (isTransferring) return;
        isTransferring = true;
        showTransferMenu = false;
        console.log('[WatchTogether] Transferring host to:', newHostUserId);
        try {
            const success = await watchTogether.transferHost(newHostUserId);
            if (success) {
                console.log('[WatchTogether] Host transferred successfully');
            } else {
                console.error('[WatchTogether] Failed to transfer host');
            }
        } catch (err) {
            console.error('[WatchTogether] Transfer host error:', err);
        } finally {
            isTransferring = false;
        }
    }

    // Toggle visibility
    async function handleToggleVisibility() {
        if (isTogglingVisibility || !watchTogether.session) return;
        isTogglingVisibility = true;
        try {
            const newValue = watchTogether.session.visibility === 'listed' ? 'unlisted' : 'listed';
            await watchTogether.setVisibility(newValue);
        } catch (err) {
            console.error('[WatchTogether] Toggle visibility error:', err);
        } finally {
            isTogglingVisibility = false;
        }
    }

    // Copy join link to clipboard
    async function handleCopyLink() {
        const link = watchTogether.getJoinLink();
        if (!link) return;

        try {
            await navigator.clipboard.writeText(link);
            copiedLink = true;
            setTimeout(() => {
                copiedLink = false;
            }, 2000);
        } catch (err) {
            console.error('[WatchTogether] Copy link error:', err);
            // Fallback: select text
            const input = document.createElement('input');
            input.value = link;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            copiedLink = true;
            setTimeout(() => {
                copiedLink = false;
            }, 2000);
        }
    }
</script>

{#if isOpen}
    <div class="watch-together-panel player-menu">
        {#if watchTogether.isInWatchParty}
            <!-- In session view - show participants -->
            <div class="session-panel player-menu">
                <div class="session-header">
                    <span class="live-indicator">
                        <span class="live-dot"></span>
                        WATCH PARTY
                    </span>
                </div>

                <div class="participants">
                    {#each watchTogether.watchPartyParticipants as participant (participant.clientId)}
                        <div class="participant" title={participant.displayName ?? undefined}>
                            <img
                                src={participant.images.primary.href}
                                alt={participant.displayName ?? ''}
                                class="participant-avatar" />
                            {#if participant.userId === watchTogether.session?.host.userId}
                                <span class="host-badge">★</span>
                            {/if}
                        </div>
                    {/each}
                </div>

                <!-- Stall Indicator - Persistent indicator when someone is buffering -->
                {#if watchTogether.isWatchPartyStalled}
                    <div class="stall-indicator">
                        <div class="stall-spinner"></div>
                        <span
                            >{m.watch_party_waiting_for({
                                username: watchTogether.watchPartyStalledByUser || 'someone',
                            })}</span>
                    </div>
                {/if}

                <!-- Host Activity Indicator (guests only, when host is not watching) -->
                {#if !watchTogether.isWatchPartyHost && watchTogether.watchPartyHostActivity !== 'watching'}
                    <div class="host-activity-indicator">
                        {#if watchTogether.watchPartyHostActivity === 'searching'}
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke-width="2"
                                stroke="currentColor"
                                width="14"
                                height="14">
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                            </svg>
                            <span>{m.watch_party_host_searching()}</span>
                        {:else if watchTogether.watchPartyHostActivity === 'browsing'}
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke-width="2"
                                stroke="currentColor"
                                width="14"
                                height="14">
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
                            </svg>
                            <span>{m.watch_party_host_browsing()}</span>
                        {/if}
                    </div>
                {/if}

                <!-- Sync Status Indicator (guests only) — with a pin toggle to keep
                     it visible in the player even when this panel is closed. -->
                {#if !watchTogether.isWatchPartyHost}
                    <div class="sync-status-slot">
                        <SyncStatusIndicator
                            showPin
                            pinned={watchPartySyncPin.pinned}
                            onTogglePin={() => watchPartySyncPin.toggle()} />
                    </div>
                {/if}

                <!-- Host Controls -->
                {#if watchTogether.isWatchPartyHost}
                    <div class="host-controls">
                        <!-- Copy Link Button -->
                        <button
                            class="host-action-btn copy-link"
                            onclick={handleCopyLink}
                            title={m.watch_party_copy_link()}>
                            {#if copiedLink}
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke-width="2"
                                    stroke="currentColor"
                                    width="14"
                                    height="14">
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="m4.5 12.75 6 6 9-13.5" />
                                </svg>
                                <span>{m.watch_party_copied()}</span>
                            {:else}
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke-width="2"
                                    stroke="currentColor"
                                    width="14"
                                    height="14">
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                                </svg>
                                <span>{m.watch_party_copy_link()}</span>
                            {/if}
                        </button>

                        <!-- Visibility Toggle -->
                        <button
                            class="host-action-btn visibility"
                            class:public={watchTogether.session?.visibility === 'listed'}
                            class:private={watchTogether.session?.visibility !== 'listed'}
                            onclick={handleToggleVisibility}
                            disabled={isTogglingVisibility}
                            title={watchTogether.session?.visibility === 'listed'
                                ? m.watch_party_public_hint()
                                : m.watch_party_private_hint()}>
                            {#if watchTogether.session?.visibility === 'listed'}
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke-width="2"
                                    stroke="currentColor"
                                    width="14"
                                    height="14">
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                                </svg>
                                <span>{m.watch_party_public()}</span>
                            {:else}
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke-width="2"
                                    stroke="currentColor"
                                    width="14"
                                    height="14">
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                                </svg>
                                <span>{m.watch_party_private()}</span>
                            {/if}
                        </button>

                        <!-- Transfer Host Button -->
                        {#if guests.length > 0}
                            <div class="transfer-container">
                                <button
                                    class="host-action-btn transfer"
                                    onclick={() => (showTransferMenu = !showTransferMenu)}
                                    disabled={isTransferring}
                                    title={m.watch_party_transfer_host()}>
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke-width="2"
                                        stroke="currentColor"
                                        width="14"
                                        height="14">
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                                    </svg>
                                    {#if isTransferring}
                                        <span>...</span>
                                    {:else}
                                        <span>{m.watch_party_transfer_host()}</span>
                                    {/if}
                                </button>

                                <!-- Transfer Menu Dropdown -->
                                {#if showTransferMenu}
                                    <div class="transfer-menu player-menu">
                                        <div class="transfer-menu-header">
                                            {m.watch_party_transfer_to_whom()}
                                        </div>
                                        {#each guests as guest (guest.userId)}
                                            <button
                                                class="transfer-option"
                                                onclick={() => handleTransferHost(guest.userId)}>
                                                <img
                                                    src={guest.images.primary.href}
                                                    alt={guest.displayName ?? ''}
                                                    class="transfer-avatar" />
                                                <span>{guest.displayName}</span>
                                            </button>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        {/if}

                        <!-- Disband Button -->
                        <button
                            class="host-action-btn disband"
                            onclick={handleDisbandSession}
                            disabled={isDisbanding}
                            title={m.watch_party_disband()}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke-width="2"
                                stroke="currentColor"
                                width="14"
                                height="14">
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    d="M6 18 18 6M6 6l12 12" />
                            </svg>
                            {#if isDisbanding}
                                <span>...</span>
                            {:else}
                                <span>{m.watch_party_disband()}</span>
                            {/if}
                        </button>
                    </div>
                {/if}

                <button class="leave-btn" onclick={handleLeaveSession} disabled={isLeaving}>
                    {#if isLeaving}
                        {m.watch_party_leaving()}
                    {:else}
                        {m.watch_party_leave()}
                    {/if}
                </button>
            </div>
        {:else if joinMode === 'sessions'}
            <!-- Active parties browse sub-panel -->
            <div class="join-sub-panel">
                {#if isLoadingSessions}
                    <div class="sessions-loading">
                        <div class="spinner-small"></div>
                        <span>Loading parties...</span>
                    </div>
                {:else if publicSessions.length > 0}
                    <div class="public-sessions">
                        <div class="sessions-header">Active Parties</div>
                        <div class="sessions-list">
                            {#each publicSessions as session (session.code)}
                                <button
                                    class="session-item"
                                    onclick={() => handleJoinPublicParty(session)}
                                    disabled={joiningSessionCode !== null}>
                                    <span class="session-host-avatar" aria-hidden="true">
                                        {session.host.displayName?.[0]?.toUpperCase() ?? '?'}
                                    </span>
                                    <div class="session-info">
                                        <span class="session-host">{session.host.displayName}</span>
                                        <span class="session-title">{session.title}</span>
                                    </div>
                                    <div class="session-participants">
                                        <span>{session.participantCount}</span>
                                    </div>
                                    {#if joiningSessionCode === session.code}
                                        <div class="spinner-small"></div>
                                    {/if}
                                </button>
                            {/each}
                        </div>
                    </div>
                {:else}
                    <div class="no-sessions">No active parties right now</div>
                {/if}
                <button class="back-btn" onclick={() => (joinMode = null)}>← Back</button>
            </div>
        {:else if joinMode === 'code'}
            <!-- Enter code sub-panel -->
            <div class="join-sub-panel">
                <input
                    type="text"
                    class="join-input"
                    placeholder={m.watch_party_enter_code_placeholder()}
                    bind:value={joinCode}
                    onkeydown={handleJoinKeydown}
                    maxlength="6"
                    disabled={isJoining} />
                {#if joinError}
                    <div class="join-error">{joinError}</div>
                {/if}
                <div class="join-buttons">
                    <button
                        class="join-confirm-btn"
                        onclick={handleJoinSession}
                        disabled={isJoining || !joinCode.trim()}>
                        {#if isJoining}
                            <div class="spinner-small"></div>
                        {:else}
                            Join
                        {/if}
                    </button>
                    <button
                        class="join-cancel-btn"
                        onclick={() => {
                            joinMode = null;
                            joinCode = '';
                            joinError = '';
                        }}
                        disabled={isJoining}>
                        Cancel
                    </button>
                </div>
            </div>
        {:else}
            <!-- Main three-row menu -->
            <div class="pre-party-menu">
                <div class="pre-party-header">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        width="14"
                        height="14">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    Watch Party
                </div>
                <label class="pre-party-row">
                    <input type="checkbox" bind:checked={listPublicly} />
                    <span>{m.watch_party_list_publicly()}</span>
                </label>
                <button
                    class="pre-party-row create"
                    onclick={handleCreateSession}
                    disabled={isCreating}>
                    {#if isCreating}
                        <div class="spinner-small"></div>
                    {:else}
                        <span>✨</span>
                    {/if}
                    <span>Start a party</span>
                </button>
                <button
                    class="pre-party-row"
                    onclick={() => {
                        joinMode = 'sessions';
                        fetchPublicParties();
                    }}>
                    <span>🔍</span>
                    <span>Active parties</span>
                </button>
                <button class="pre-party-row" onclick={() => (joinMode = 'code')}>
                    <span>🔑</span>
                    <span>Enter code</span>
                </button>
            </div>
        {/if}
    </div>
{/if}

<style>
    .watch-together-panel {
        padding: 10px;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    /* Session Panel */
    .session-panel {
        padding: 0.75rem;
        min-width: 140px;
    }

    .session-header {
        margin-bottom: 0.5rem;
    }

    .live-indicator {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.65rem;
        font-weight: 600;
        color: #ef4444;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .live-dot {
        width: 6px;
        height: 6px;
        background: #ef4444;
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

    .participants {
        display: flex;
        gap: 0.25rem;
        flex-wrap: wrap;
        margin-bottom: 0.5rem;
    }

    .participant {
        position: relative;
    }

    .participant-avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.3);
        object-fit: cover;
    }

    .host-badge {
        position: absolute;
        bottom: -2px;
        right: -2px;
        background: #fbbf24;
        color: #000;
        font-size: 0.5rem;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .leave-btn {
        width: 100%;
        padding: 0.4rem;
        background: rgba(239, 68, 68, 0.3);
        border: 1px solid rgba(239, 68, 68, 0.5);
        border-radius: 6px;
        color: white;
        font-size: 0.75rem;
        cursor: pointer;
        transition: all 0.2s;
    }

    .leave-btn:hover:not(:disabled) {
        background: rgba(239, 68, 68, 0.5);
    }

    .leave-btn:disabled {
        opacity: 0.7;
        cursor: wait;
    }

    /* Join sub-panel (sessions list / code input) */
    .join-sub-panel {
        min-width: 200px;
        max-width: 280px;
    }

    /* Pre-party menu (three-row create/browse/code) */
    .pre-party-menu {
        min-width: 200px;
    }

    .pre-party-header {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 8px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.09em;
        color: #a78bfa;
        margin-bottom: 8px;
    }

    .pre-party-row {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        background: rgba(255, 255, 255, 0.05);
        border: none;
        border-radius: 7px;
        padding: 7px 8px;
        color: #e2e8f0;
        font-size: 12px;
        cursor: pointer;
        margin-bottom: 4px;
        text-align: left;
        transition: background 0.15s;
    }

    .pre-party-row:last-child {
        margin-bottom: 0;
    }

    .pre-party-row:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
    }

    .pre-party-row.create {
        background: rgba(139, 92, 246, 0.3);
        color: #ddd6fe;
    }

    .pre-party-row.create:hover:not(:disabled) {
        background: rgba(139, 92, 246, 0.45);
    }

    .pre-party-row:disabled {
        opacity: 0.6;
        cursor: wait;
    }

    .no-sessions {
        font-size: 11px;
        color: #64748b;
        text-align: center;
        padding: 0.75rem 0;
    }

    .back-btn {
        background: none;
        border: none;
        color: #94a3b8;
        font-size: 11px;
        cursor: pointer;
        padding: 4px 0;
        margin-top: 4px;
        width: 100%;
        text-align: left;
    }

    .back-btn:hover {
        color: #e2e8f0;
    }

    .join-input {
        width: 100%;
        padding: 0.5rem 0.75rem;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        color: white;
        font-size: 0.9rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        text-align: center;
        outline: none;
    }

    .join-input::placeholder {
        color: rgba(255, 255, 255, 0.4);
        text-transform: none;
        letter-spacing: normal;
    }

    .join-input:focus {
        border-color: rgba(139, 92, 246, 0.6);
    }

    .join-input:disabled {
        opacity: 0.6;
    }

    .join-error {
        color: #ef4444;
        font-size: 0.7rem;
        margin-top: 0.35rem;
        text-align: center;
    }

    .join-buttons {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.5rem;
    }

    .join-confirm-btn,
    .join-cancel-btn {
        flex: 1;
        padding: 0.4rem;
        border-radius: 6px;
        font-size: 0.75rem;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .join-confirm-btn {
        background: rgba(139, 92, 246, 0.5);
        border: 1px solid rgba(139, 92, 246, 0.7);
        color: white;
    }

    .join-confirm-btn:hover:not(:disabled) {
        background: rgba(139, 92, 246, 0.7);
    }

    .join-confirm-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .join-cancel-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
    }

    .join-cancel-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.2);
    }

    .join-cancel-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .spinner-small {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    /* Host Activity Indicator */
    .host-activity-indicator {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.35rem 0.5rem;
        background: rgba(59, 130, 246, 0.2);
        border: 1px solid rgba(59, 130, 246, 0.4);
        border-radius: 6px;
        margin-bottom: 0.5rem;
        font-size: 0.7rem;
        color: #93c5fd;
    }

    .host-activity-indicator svg {
        flex-shrink: 0;
        animation: pulse 2s ease-in-out infinite;
    }

    /* Sync Status Indicator slot (component owns its own styles) */
    .sync-status-slot {
        margin-bottom: 0.5rem;
    }

    /* Stall Indicator - Prominent indicator when someone is buffering */
    .stall-indicator {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.65rem;
        background: rgba(251, 191, 36, 0.2);
        border: 1px solid rgba(251, 191, 36, 0.5);
        border-radius: 6px;
        margin-bottom: 0.5rem;
        font-size: 0.75rem;
        font-weight: 500;
        color: #fcd34d;
        animation: stall-pulse 2s ease-in-out infinite;
    }

    @keyframes stall-pulse {
        0%,
        100% {
            background: rgba(251, 191, 36, 0.2);
            border-color: rgba(251, 191, 36, 0.5);
        }
        50% {
            background: rgba(251, 191, 36, 0.3);
            border-color: rgba(251, 191, 36, 0.7);
        }
    }

    .stall-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(251, 191, 36, 0.3);
        border-top-color: #fcd34d;
        border-radius: 50%;
        animation: spin 1s linear infinite;
        flex-shrink: 0;
    }

    /* Host Controls */
    .host-controls {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        margin-bottom: 0.5rem;
    }

    .host-action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        width: 100%;
        padding: 0.35rem 0.5rem;
        border-radius: 6px;
        font-size: 0.7rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        border: 1px solid;
    }

    .host-action-btn.transfer {
        background: rgba(139, 92, 246, 0.2);
        border-color: rgba(139, 92, 246, 0.4);
        color: #c4b5fd;
    }

    .host-action-btn.transfer:hover:not(:disabled) {
        background: rgba(139, 92, 246, 0.35);
    }

    .host-action-btn.disband {
        background: rgba(239, 68, 68, 0.15);
        border-color: rgba(239, 68, 68, 0.3);
        color: #fca5a5;
    }

    .host-action-btn.disband:hover:not(:disabled) {
        background: rgba(239, 68, 68, 0.3);
    }

    .host-action-btn:disabled {
        opacity: 0.5;
        cursor: wait;
    }

    .host-action-btn svg {
        flex-shrink: 0;
    }

    /* Transfer Menu */
    .transfer-container {
        position: relative;
    }

    .transfer-menu {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        margin-top: 0.25rem;
        overflow: hidden;
        z-index: 10;
    }

    .transfer-menu-header {
        padding: 0.4rem 0.5rem;
        font-size: 0.65rem;
        color: rgba(255, 255, 255, 0.5);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .transfer-option {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.4rem 0.5rem;
        background: transparent;
        border: none;
        color: white;
        font-size: 0.75rem;
        cursor: pointer;
        transition: background 0.2s;
    }

    .transfer-option:hover {
        background: rgba(139, 92, 246, 0.3);
    }

    .transfer-avatar {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        object-fit: cover;
    }

    /* Copy Link Button */
    .host-action-btn.copy-link {
        background: rgba(59, 130, 246, 0.2);
        border-color: rgba(59, 130, 246, 0.4);
        color: #93c5fd;
    }

    .host-action-btn.copy-link:hover:not(:disabled) {
        background: rgba(59, 130, 246, 0.35);
    }

    /* Visibility Button */
    .host-action-btn.visibility.public {
        background: rgba(34, 197, 94, 0.15);
        border-color: rgba(34, 197, 94, 0.3);
        color: #86efac;
    }

    .host-action-btn.visibility.public:hover:not(:disabled) {
        background: rgba(34, 197, 94, 0.25);
    }

    .host-action-btn.visibility.private {
        background: rgba(249, 115, 22, 0.15);
        border-color: rgba(249, 115, 22, 0.3);
        color: #fdba74;
    }

    .host-action-btn.visibility.private:hover:not(:disabled) {
        background: rgba(249, 115, 22, 0.25);
    }

    /* Public Sessions List */
    .sessions-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.75rem;
        color: rgba(255, 255, 255, 0.6);
        font-size: 0.75rem;
    }

    .public-sessions {
        margin-bottom: 0.5rem;
    }

    .sessions-header {
        font-size: 0.65rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.5);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 0.35rem;
    }

    .sessions-list {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        max-height: 150px;
        overflow-y: auto;
    }

    .session-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem;
        background: rgba(139, 92, 246, 0.15);
        border: 1px solid rgba(139, 92, 246, 0.3);
        border-radius: 8px;
        color: white;
        cursor: pointer;
        transition: all 0.2s;
        text-align: left;
    }

    .session-item:hover:not(:disabled) {
        background: rgba(139, 92, 246, 0.3);
        border-color: rgba(139, 92, 246, 0.5);
    }

    .session-item:disabled {
        opacity: 0.6;
        cursor: wait;
    }

    .session-host-avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        object-fit: cover;
        border: 2px solid rgba(139, 92, 246, 0.5);
        flex-shrink: 0;
    }

    .session-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
    }

    .session-host {
        font-size: 0.75rem;
        font-weight: 600;
        color: white;
    }

    .session-title {
        font-size: 0.65rem;
        color: rgba(255, 255, 255, 0.6);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .session-participants {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        color: rgba(255, 255, 255, 0.5);
        font-size: 0.7rem;
        flex-shrink: 0;
    }
</style>
