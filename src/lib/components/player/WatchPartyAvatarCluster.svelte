<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { WatchTogetherParticipant } from '$lib/schemas/watch-together-core-types';
    import { playerStore } from '$lib/components/player/playerStore.svelte';
    import {
        computeClusterDisplay,
        getAvatarSizeForIndex,
    } from '$lib/components/player/watch-party-cluster';

    interface Props {
        isInParty: boolean;
        participants: WatchTogetherParticipant[];
        currentUserId: string;
        hostUserId?: string;
        avatarUrl?: string;
        displayName: string;
        isOpen: boolean;
        ontoggle: () => void;
        onclose?: () => void;
        children?: Snippet;
    }

    let {
        isInParty,
        participants,
        currentUserId,
        hostUserId,
        avatarUrl,
        displayName,
        isOpen,
        ontoggle,
        onclose = undefined,
        children,
    }: Props = $props();

    let wrapperEl = $state<HTMLDivElement | undefined>(undefined);
    let soloAvatarFailed = $state(false);

    const display = $derived(computeClusterDisplay(participants, currentUserId));

    const initial = $derived(displayName ? displayName[0].toUpperCase() : '?');

    function handleClickOutside(event: MouseEvent): void {
        if (wrapperEl && !wrapperEl.contains(event.target as Node)) {
            if (onclose) {
                onclose();
            } else {
                ontoggle();
            }
        }
    }

    $effect(() => {
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => {
                document.removeEventListener('mousedown', handleClickOutside);
            };
        }
    });

    $effect(() => {
        if (avatarUrl) soloAvatarFailed = false;
    });
</script>

{#if playerStore.showControls || isOpen}
    <div class="cluster-wrapper" bind:this={wrapperEl}>
        <button
            type="button"
            class="cluster-btn"
            class:open={isOpen}
            aria-expanded={isOpen}
            aria-label="Watch party"
            onclick={ontoggle}>
            {#if isInParty}
                <div class="avatar-stack">
                    {#if display.overflowCount > 0}
                        <div
                            class="overflow-chip av"
                            style="width: 30px; height: 30px;"
                            aria-label="+{display.overflowCount} more">
                            +{display.overflowCount}
                        </div>
                    {/if}
                    {#each display.visible as participant, i (participant.clientId)}
                        {@const size = getAvatarSizeForIndex(i, display.visible.length)}
                        {@const isHost = participant.userId === hostUserId}
                        {@const isSelf = participant.userId === currentUserId}
                        {@const isLast = i === display.visible.length - 1}
                        <div
                            class="avatar-slot"
                            style="position: relative; flex-shrink: 0;"
                            role="img"
                            aria-label={participant.displayName ?? undefined}>
                            {#if isSelf && avatarUrl}
                                <img
                                    src={avatarUrl}
                                    alt={participant.displayName ?? ''}
                                    class="av"
                                    class:pulse={isLast}
                                    style="width: {size}px; height: {size}px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(0,0,0,0.8);" />
                            {:else}
                                <img
                                    src={participant.images.primary.href}
                                    alt={participant.displayName ?? ''}
                                    class="av"
                                    class:pulse={isLast}
                                    style="width: {size}px; height: {size}px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(0,0,0,0.8);"
                                    onerror={(e) => {
                                        const img = e.currentTarget as HTMLImageElement;
                                        if (!img.isConnected) return;
                                        img.style.display = 'none';
                                        const next = img.nextElementSibling as HTMLElement | null;
                                        if (next) next.style.display = 'flex';
                                    }} />
                                <div
                                    class="av initials-fallback"
                                    class:pulse={isLast}
                                    style="display: none; width: {size}px; height: {size}px; border-radius: 50%; border: 2px solid rgba(0,0,0,0.8); background: linear-gradient(135deg, #7c3aed, #a855f7); align-items: center; justify-content: center; font-size: {Math.round(
                                        size * 0.4,
                                    )}px; font-weight: 600; color: #fff;"
                                    aria-hidden="true">
                                    {participant.displayName?.[0]?.toUpperCase() ?? '?'}
                                </div>
                            {/if}
                            {#if isHost}
                                <span class="crown-badge" aria-label="Host" title="Host">★</span>
                            {/if}
                        </div>
                    {/each}
                </div>
            {:else}
                <div class="solo-avatar" style="position: relative;">
                    {#if avatarUrl && !soloAvatarFailed}
                        <img
                            src={avatarUrl}
                            alt={displayName}
                            class="main-av"
                            style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover;"
                            onerror={() => (soloAvatarFailed = true)} />
                    {:else}
                        <div
                            class="main-av initials-fallback"
                            style="width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(135deg, #7c3aed, #a855f7); display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 600; color: #fff;"
                            aria-hidden="true">
                            {initial}
                        </div>
                    {/if}
                    <span class="group-badge" aria-hidden="true">👥</span>
                </div>
            {/if}
        </button>

        {#if isOpen && children}
            <div class="popup-panel">
                {@render children()}
            </div>
        {/if}
    </div>
{/if}

<style>
    .cluster-wrapper {
        position: fixed;
        top: 1.5rem;
        right: calc(1.5rem + env(safe-area-inset-right, 0px));
        z-index: 9500; /* Z.PLAYER_TOAST */
    }

    .cluster-btn {
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
    }

    .cluster-btn:hover .main-av,
    .cluster-btn.open .main-av {
        box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.6);
    }

    .avatar-stack {
        display: flex;
        align-items: center;
    }

    .avatar-stack > * + * {
        margin-left: -10px;
    }

    /* Pulse ring on last avatar (you) */
    .av.pulse {
        animation: pulse-ring 2.5s infinite;
    }

    @keyframes pulse-ring {
        0% {
            box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.65);
        }
        70% {
            box-shadow: 0 0 0 9px rgba(139, 92, 246, 0);
        }
        100% {
            box-shadow: 0 0 0 0 rgba(139, 92, 246, 0);
        }
    }

    .overflow-chip {
        border-radius: 50%;
        background: rgba(124, 58, 237, 0.85);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px solid rgba(0, 0, 0, 0.8);
        flex-shrink: 0;
    }

    .group-badge {
        position: absolute;
        bottom: -2px;
        right: -2px;
        width: 17px;
        height: 17px;
        background: #7c3aed;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        line-height: 1;
    }

    .crown-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        width: 14px;
        height: 14px;
        background: #fbbf24;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 8px;
        line-height: 1;
        color: #1a1a1a;
    }

    .popup-panel {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        min-width: 180px;
        max-width: min(220px, calc(100vw - 3rem));
    }
</style>
