<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- src/lib/components/player/AnnotationsSidebar.svelte -->
<script lang="ts">
    import './player-presentation.css';
    import { Z } from '$lib/utils/z-index';
    import { fly } from 'svelte/transition';
    import { Icon, XMark, Trash } from 'svelte-hero-icons';
    import { SvelteDate } from 'svelte/reactivity';
    import type { AnnotationData } from '$lib/types/media-annotations';
    import { getAnnotations, createAnnotation, deleteAnnotation } from '$lib/api/content';
    import * as m from '$lib/paraglide/messages';
    import { formatUsername } from '$lib/utils/data-extraction';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import { onMount } from 'svelte';

    interface Props {
        isOpen: boolean;
        mediaId: string;
        mediaTitle?: string;
        currentTime: number;
        username: string;
        showChat: boolean;
        maxPins?: number;
        isAdmin?: boolean;
        showAnnotationMarkers?: boolean;
        autoShowAnnotations?: boolean;
        onclose: () => void;
        onseek: (seconds: number) => void;
        onpinmarkers: (pins: AnnotationData[]) => void;
    }

    let {
        isOpen,
        mediaId,
        mediaTitle,
        currentTime,
        username,
        showChat,
        maxPins = 3,
        isAdmin = false,
        showAnnotationMarkers: _showAnnotationMarkers = true,
        autoShowAnnotations: _autoShowAnnotations = false,
        onclose,
        onseek,
        onpinmarkers,
    }: Props = $props();

    type Tab = 'chat' | 'pins';
    let tabChoice = $state<Tab | null>(null);
    let activeTab = $derived(tabChoice ?? (showChat ? 'chat' : 'pins'));
    let annotations = $state<AnnotationData[]>([]);
    let chatInput = $state('');
    let pinInput = $state('');
    let isSubmitting = $state(false);
    const MAX_CHAT = 500;
    const MAX_PIN_TEXT = 200;

    let chatMessages = $derived(annotations.filter((a) => a.type === 'chat'));
    let pins = $derived(annotations.filter((a) => a.type === 'pin'));
    let userPinCount = $derived(pins.filter((p) => p.username === username).length);
    let sortedPins = $derived(
        pins.toSorted((a, b) => Number(a.timestamp_seconds) - Number(b.timestamp_seconds)),
    );

    let pollInterval: ReturnType<typeof setInterval> | null = null;

    // Load on mount so seekbar pin markers are populated before the sidebar opens
    onMount(() => {
        loadAnnotations();
    });

    // Poll for updates while the sidebar is open
    $effect(() => {
        if (isOpen) {
            pollInterval = setInterval(loadAnnotations, 5000);
        } else {
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        }
        return () => {
            if (pollInterval) clearInterval(pollInterval);
        };
    });

    $effect(() => {
        onpinmarkers(pins);
    });

    async function loadAnnotations(): Promise<void> {
        const { data, error } = await getAnnotations(mediaId);
        if (error || !data) return;
        annotations = data.items;
    }

    async function sendChat(): Promise<void> {
        if (!chatInput.trim() || isSubmitting) return;
        isSubmitting = true;
        try {
            const { data, error } = await createAnnotation(mediaId, {
                type: 'chat',
                content: chatInput.trim(),
            });
            if (!error && data) {
                annotations = [...annotations, data];
                chatInput = '';
            }
        } finally {
            isSubmitting = false;
        }
    }

    async function sendPin(): Promise<void> {
        if (!pinInput.trim() || isSubmitting || userPinCount >= maxPins) return;
        isSubmitting = true;
        try {
            const { data, error } = await createAnnotation(mediaId, {
                type: 'pin',
                content: pinInput.trim(),
                timestamp_seconds: currentTime,
            });
            if (!error && data) {
                annotations = [...annotations, data];
                pinInput = '';
            }
        } finally {
            isSubmitting = false;
        }
    }

    async function removeAnnotation(id: string): Promise<void> {
        const { error } = await deleteAnnotation(mediaId, id);
        if (!error) {
            annotations = annotations.filter((a) => a.id !== id);
        }
    }

    function formatTime(seconds: number | null | undefined): string {
        if (seconds == null) return '';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function formatMessageTime(dateStr: string): string {
        const date = new SvelteDate(dateStr);
        const now = new SvelteDate();
        const isToday = date.toDateString() === now.toDateString();
        if (isToday) {
            return date.toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
            });
        }
        return date.toLocaleDateString(undefined, {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function handleImageError(event: Event): void {
        const img = event.target as HTMLImageElement;
        if (img) img.style.display = 'none';
    }
</script>

{#if isOpen}
    <div
        class="player-drawer absolute right-0 top-0 h-full w-80 flex flex-col border-l border-white/10"
        style="z-index: {Z.PLAYER_ANNOTATIONS};"
        transition:fly={{ x: 320, duration: 250 }}>
        <!-- Header -->
        <div class="player-drawer-header">
            <div class="flex flex-col min-w-0 mr-2">
                <span class="font-semibold text-sm tracking-wide"
                    >{m.annotations_sidebar_title()}</span>
                {#if mediaTitle}
                    <span class="text-xs text-white/40 truncate">{mediaTitle}</span>
                {/if}
            </div>
            <button
                class="p-1.5 hover:bg-white/10 rounded-lg transition-colors shrink-0"
                onclick={onclose}
                aria-label={m.annotations_close()}>
                <Icon src={XMark} class="w-4 h-4 text-white" />
            </button>
        </div>

        <!-- Tabs -->
        <div class="flex border-b border-white/10 shrink-0">
            {#if showChat}
                <button
                    class="flex-1 py-2.5 text-sm transition-colors border-b-2 {activeTab === 'chat'
                        ? 'text-indigo-200 border-indigo-300'
                        : 'text-white/50 border-transparent hover:text-white/80'}"
                    onclick={() => (tabChoice = 'chat')}>
                    {m.annotations_tab_chat()}
                </button>
            {/if}
            <button
                class="flex-1 py-2.5 text-sm transition-colors border-b-2 {activeTab === 'pins'
                    ? 'text-amber-400 border-amber-400'
                    : 'text-white/50 border-transparent hover:text-white/80'}"
                onclick={() => (tabChoice = 'pins')}>
                {m.annotations_tab_pins({ count: pins.length })}
            </button>
        </div>

        <!-- Chat tab -->
        {#if activeTab === 'chat' && showChat}
            <div class="flex-1 overflow-y-auto p-3 space-y-3 sidebar-scroll">
                {#each chatMessages as msg (msg.id)}
                    <div
                        class="group flex gap-2 {msg.username === username
                            ? 'flex-row-reverse'
                            : ''}">
                        <!-- Avatar -->
                        <div
                            class="shrink-0 w-7 h-7 rounded-full overflow-hidden bg-surface-700 relative">
                            <span
                                class="absolute inset-0 flex items-center justify-center text-xs text-surface-400 font-medium">
                                {msg.username.slice(0, 1).toUpperCase()}
                            </span>
                            <img
                                src={getAvatarUrl(msg.username)}
                                alt={msg.username}
                                class="absolute inset-0 w-full h-full object-cover bg-surface-700"
                                onerror={handleImageError} />
                        </div>
                        <!-- Message bubble -->
                        <div class="flex-1 min-w-0 {msg.username === username ? 'text-right' : ''}">
                            <div class="inline-block max-w-[85%] text-left">
                                <div
                                    class="flex items-center gap-2 mb-0.5 {msg.username === username
                                        ? 'flex-row-reverse'
                                        : ''}">
                                    <span class="text-xs font-medium text-surface-300">
                                        {msg.username === username
                                            ? m.annotations_chat_you()
                                            : formatUsername(msg.username)}
                                    </span>
                                    <span class="text-xs text-surface-500">
                                        {formatMessageTime(msg.created_at)}
                                    </span>
                                </div>
                                <div class="relative">
                                    <p
                                        class="px-3 py-2 rounded-lg text-sm break-words {msg.username ===
                                        username
                                            ? 'bg-primary-600/30 text-surface-100'
                                            : 'bg-surface-700/80 text-surface-200'}">
                                        {msg.content}
                                    </p>
                                    {#if msg.username === username || isAdmin}
                                        <button
                                            class="absolute top-1/2 -translate-y-1/2 -left-7 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-error-500/20 text-error-400"
                                            onclick={() => removeAnnotation(msg.id)}
                                            aria-label={m.annotations_chat_delete()}>
                                            <Icon src={Trash} class="w-3.5 h-3.5" />
                                        </button>
                                    {/if}
                                </div>
                            </div>
                        </div>
                    </div>
                {/each}
                {#if chatMessages.length === 0}
                    <p class="text-surface-500 text-sm text-center py-8">
                        {m.annotations_chat_empty()}
                    </p>
                {/if}
            </div>
            <!-- Chat input -->
            <div class="p-3 border-t border-white/10 shrink-0">
                <div class="flex gap-2">
                    <input
                        bind:value={chatInput}
                        placeholder={m.annotations_chat_placeholder()}
                        maxlength={MAX_CHAT}
                        class="flex-1 bg-white/10 border border-white/20 rounded-lg text-white text-sm px-3 py-2 placeholder-white/40 focus:outline-none focus:border-white/40"
                        onkeydown={(e) => e.key === 'Enter' && sendChat()} />
                    <button
                        onclick={sendChat}
                        disabled={isSubmitting || !chatInput.trim()}
                        class="px-3 py-2 bg-primary-600 hover:bg-primary-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm text-white transition-colors">
                        {m.annotations_chat_send()}
                    </button>
                </div>
                {#if chatInput.length > MAX_CHAT * 0.8}
                    <p
                        class="text-xs mt-1 text-right {chatInput.length >= MAX_CHAT
                            ? 'text-error-400'
                            : 'text-white/30'}">
                        {chatInput.length}/{MAX_CHAT}
                    </p>
                {/if}
            </div>
        {/if}

        <!-- Pins tab -->
        {#if activeTab === 'pins'}
            <div class="flex-1 overflow-y-auto p-3 space-y-2 sidebar-scroll">
                {#each sortedPins as pin (pin.id)}
                    <div
                        class="group flex items-start gap-2 p-2.5 bg-white/5 hover:bg-white/10 rounded-lg cursor-pointer transition-colors"
                        role="button"
                        tabindex="0"
                        onclick={() => onseek(Number(pin.timestamp_seconds))}
                        onkeydown={(e) =>
                            e.key === 'Enter' && onseek(Number(pin.timestamp_seconds))}>
                        <span
                            class="text-amber-400 font-semibold text-xs shrink-0 mt-0.5 tabular-nums w-8">
                            {formatTime(Number(pin.timestamp_seconds))}
                        </span>
                        <!-- Avatar -->
                        <div
                            class="shrink-0 w-6 h-6 rounded-full overflow-hidden bg-surface-700 relative mt-0.5">
                            <span
                                class="absolute inset-0 flex items-center justify-center text-surface-400 font-medium"
                                style="font-size: 9px">
                                {pin.username.slice(0, 1).toUpperCase()}
                            </span>
                            <img
                                src={getAvatarUrl(pin.username)}
                                alt={pin.username}
                                class="absolute inset-0 w-full h-full object-cover bg-surface-700"
                                onerror={handleImageError} />
                        </div>
                        <div class="flex-1 min-w-0">
                            <span class="text-xs text-white/50 block"
                                >{formatUsername(pin.username)}</span>
                            <span class="text-sm text-white/90 break-words">{pin.content}</span>
                        </div>
                        {#if pin.username === username || isAdmin}
                            <button
                                class="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-error-500/20 text-error-400"
                                onclick={(e) => {
                                    e.stopPropagation();
                                    removeAnnotation(pin.id);
                                }}
                                aria-label={m.annotations_pin_delete()}>
                                <Icon src={Trash} class="w-3.5 h-3.5" />
                            </button>
                        {/if}
                    </div>
                {/each}
                {#if pins.length === 0}
                    <p class="text-white/40 text-sm text-center py-8">
                        {m.annotations_pins_empty()}
                    </p>
                {/if}
            </div>

            <!-- Pin creation -->
            <div class="p-3 border-t border-white/10 shrink-0 space-y-2">
                {#if userPinCount < maxPins}
                    <div class="flex items-center justify-between">
                        <span class="flex items-center gap-1 text-xs text-amber-400/80">
                            <span>⏱</span>
                            {formatTime(currentTime)}
                        </span>
                        <span class="text-xs text-white/30"
                            >{m.annotations_pin_counter({
                                used: userPinCount,
                                max: maxPins,
                            })}</span>
                    </div>
                    <div class="flex gap-2">
                        <input
                            bind:value={pinInput}
                            placeholder={m.annotations_pin_placeholder()}
                            maxlength={MAX_PIN_TEXT}
                            class="flex-1 bg-white/10 border border-white/20 rounded-lg text-white text-sm px-3 py-2 placeholder-white/40 focus:outline-none focus:border-amber-400/60"
                            onkeydown={(e) => e.key === 'Enter' && sendPin()} />
                        <button
                            onclick={sendPin}
                            disabled={isSubmitting || !pinInput.trim()}
                            class="px-3 py-2 bg-amber-500/80 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm text-white transition-colors">
                            {m.annotations_pin_submit()}
                        </button>
                    </div>
                    {#if pinInput.length > MAX_PIN_TEXT * 0.8}
                        <p
                            class="text-xs mt-1 text-right {pinInput.length >= MAX_PIN_TEXT
                                ? 'text-error-400'
                                : 'text-white/30'}">
                            {pinInput.length}/{MAX_PIN_TEXT}
                        </p>
                    {/if}
                {:else}
                    <p class="text-white/40 text-sm text-center py-2">
                        {m.annotations_pins_limit_reached({ max: maxPins })}
                    </p>
                {/if}
            </div>
        {/if}
    </div>
{/if}

<style>
    .sidebar-scroll::-webkit-scrollbar {
        width: 4px;
    }
    .sidebar-scroll::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 2px;
    }
    .sidebar-scroll::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 2px;
    }
    .sidebar-scroll::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.4);
    }
</style>
