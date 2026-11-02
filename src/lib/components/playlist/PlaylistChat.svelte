<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteDate } from 'svelte/reactivity';

    import { onMount, onDestroy } from 'svelte';
    import {
        Icon,
        ChatBubbleLeftRight,
        PaperAirplane,
        Trash,
        ChevronDown,
        ChevronUp,
        Eye,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    import { preventDefault } from '$lib/utils/event-helpers';
    import * as playlistsApi from '$lib/api/playlists';
    import type { ChatMessageData } from '$lib/schemas/playlists';
    import { page } from '$app/stores';
    import { CLIENT_TUNING_DEFAULTS } from '$lib/stores/client-tuning';

    interface Props {
        playlistId: number;
        currentUser: string;
        isOwner?: boolean;
    }

    let { playlistId, currentUser, isOwner = false }: Props = $props();

    type ChatMessage = ChatMessageData;

    let messages: ChatMessage[] = $state([]);
    let newMessage = $state('');
    let loading = $state(true);
    let sending = $state(false);
    let deleting = $state<number | null>(null);
    let collapsed = $state(false);
    let messagesContainer: HTMLDivElement | undefined = $state();
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let lastMessageId: number | null = null;
    let disposed = false;
    let reading = false;
    let revision = 0;
    let actionError = $state('');
    let readError = $state('');
    let pollCount = 0; // Track polls to do full refresh occasionally

    // Polling config. The interval is operator-tunable via
    // PLAYLIST_CHAT_POLL_MS (default 15s, schema-bounded 5s..60s). Read off
    // page data, not the hydrated client-tuning module: this runs during
    // component init, before the layout's hydration $effect is guaranteed to
    // have flushed.
    // FULL_REFRESH_EVERY counts POLLS, not wall-clock, so the full-refresh
    // cadence scales with the configured interval (90s at the default, 30s at
    // the 5s floor, 6min at the 60s ceiling) — intentional: a full refresh is
    // there to reconcile edits/deletes the lightweight poll cannot see, and
    // that reconciliation need only keep pace with polling.
    const POLL_INTERVAL_MS =
        $page.data.clientTuning?.playlistChatPollMs ?? CLIENT_TUNING_DEFAULTS.playlistChatPollMs;
    const FULL_REFRESH_EVERY = 6; // Do full refresh every 6 polls

    // Load saved collapsed state
    let COLLAPSED_KEY = $derived(`playlist-chat-collapsed-${playlistId}`);

    onMount(() => {
        collapsed = localStorage.getItem(COLLAPSED_KEY) === 'true';
        void loadMessages(true); // Start the timer synchronously so teardown always clears it.
        // Start lightweight polling — skip when the tab is hidden so chats
        // nobody is reading don't burn fetches every 15s.
        pollInterval = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return;
            void pollForNewMessages();
        }, POLL_INTERVAL_MS);
    });

    onDestroy(() => {
        disposed = true;
        if (pollInterval) {
            clearInterval(pollInterval);
        }
    });

    // One read at a time, and ignore reads overtaken by a local mutation or teardown.
    async function loadMessages(checkWatched = false, incremental = false) {
        if (disposed || reading) return;
        reading = true;
        const readRevision = revision;
        try {
            const { data, error } = await playlistsApi.getChatMessages(playlistId, {
                checkWatched,
                ...(incremental && lastMessageId !== null ? { since: lastMessageId } : {}),
            });
            if (disposed || readRevision !== revision) return;
            if (error || !data) throw error ?? new Error('Missing chat response');
            readError = '';
            const freshItems = Array.isArray(data.items) ? data.items : [];
            if (incremental) {
                const existingIds = new Set(messages.map((message) => message.id));
                messages = [
                    ...messages,
                    ...freshItems.filter((message) => !existingIds.has(message.id)),
                ];
            } else {
                messages = freshItems;
            }
            lastMessageId = messages.length
                ? Math.max(...messages.map((message) => message.id))
                : null;
            scrollToBottom();
        } catch (e) {
            console.error('Failed to load chat messages:', e);
            if (!disposed && readRevision === revision) readError = m.error_generic();
        } finally {
            reading = false;
            if (!disposed) loading = false;
        }
    }

    async function pollForNewMessages() {
        if (collapsed || disposed) return;
        pollCount++;
        const fullRefresh = lastMessageId === null || pollCount >= FULL_REFRESH_EVERY;
        if (fullRefresh) pollCount = 0;
        await loadMessages(fullRefresh, !fullRefresh);
    }

    async function sendMessage() {
        if (!newMessage.trim() || sending) return;

        sending = true;
        actionError = '';
        const draft = newMessage;
        try {
            const { data, error } = await playlistsApi.sendChatMessage(playlistId, draft.trim());
            if (disposed) return;
            if (error || !data) throw error ?? new Error('Missing chat response');
            revision++;
            pollCount = FULL_REFRESH_EVERY;

            if (data) {
                // New contract: bare ChatMessage object (id, username, message, message_type, created_at)
                const chatMsg = data;
                // A concurrent poll may have already appended this message.
                if (!messages.some((mm) => mm.id === chatMsg.id)) {
                    messages = [...messages, chatMsg];
                }
                lastMessageId = Math.max(lastMessageId ?? 0, chatMsg.id); // Update for polling
                if (newMessage === draft) newMessage = '';
                scrollToBottom();
            }
        } catch (e) {
            console.error('Failed to send message:', e);
            if (!disposed) actionError = m.error_generic();
        } finally {
            sending = false;
        }
    }

    async function deleteMessage(messageId: number) {
        if (deleting) return;

        deleting = messageId;
        actionError = '';
        try {
            const { error: apiError } = await playlistsApi.deleteChatMessage(playlistId, messageId);

            if (disposed) return;
            if (apiError) throw apiError;
            revision++;
            pollCount = FULL_REFRESH_EVERY;
            if (!apiError) {
                messages = messages.filter((m) => m.id !== messageId);
            }
        } catch (e) {
            console.error('Failed to delete message:', e);
            if (!disposed) actionError = m.error_generic();
        } finally {
            deleting = null;
        }
    }

    function scrollToBottom() {
        setTimeout(() => {
            if (messagesContainer) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
        }, 50);
    }

    function bindMessagesContainer(node: HTMLDivElement) {
        messagesContainer = node;
        return () => {
            if (messagesContainer === node) {
                messagesContainer = undefined;
            }
        };
    }

    function toggleCollapsed() {
        collapsed = !collapsed;
        localStorage.setItem(COLLAPSED_KEY, String(collapsed));
        if (!collapsed) {
            void loadMessages(true);
            scrollToBottom();
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    }

    function formatTime(dateStr: string): string {
        const date = new SvelteDate(dateStr);
        const now = new SvelteDate();
        const isToday = date.toDateString() === now.toDateString();

        if (isToday) {
            return date.toLocaleTimeString(getLocale(), {
                hour: '2-digit',
                minute: '2-digit',
            });
        }

        const yesterday = new SvelteDate(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const isYesterday = date.toDateString() === yesterday.toDateString();

        if (isYesterday) {
            return `${m.chat_yesterday()} ${date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })}`;
        }

        return date.toLocaleDateString(getLocale(), {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function canDelete(msg: ChatMessage): boolean {
        // System messages can only be deleted by owner
        if (msg.messageType === 'system') {
            return isOwner;
        }
        return msg.author.userId === currentUser || isOwner;
    }

    function handleImageError(event: Event) {
        const img = event.target as HTMLImageElement;
        if (img) img.style.display = 'none';
    }
</script>

<div class="card bg-surface-800 overflow-hidden">
    <!-- Header -->
    <button
        type="button"
        class="w-full px-4 py-3 between hover:bg-surface-700/50 transition-colors"
        onclick={toggleCollapsed}>
        <div class="flex items-center gap-2">
            <Icon src={ChatBubbleLeftRight} class="w-5 h-5 text-surface-400" />
            <span class="font-medium">{m.page_chat()}</span>
            {#if messages.length > 0}
                <span class="text-xs text-surface-500">({messages.length})</span>
            {/if}
        </div>
        <Icon src={collapsed ? ChevronUp : ChevronDown} class="w-5 h-5 text-surface-400" />
    </button>

    <!-- Chat content -->
    {#if actionError || readError}
        <p role="alert" class="px-4 py-2 text-sm text-error-300">{actionError || readError}</p>
    {/if}
    {#if !collapsed}
        <div class="border-t border-surface-700">
            <!-- Messages area -->
            <div {@attach bindMessagesContainer} class="h-64 overflow-y-auto p-3 space-y-3">
                {#if loading}
                    <div class="center py-8">
                        <span class="loading-spinner loading-spinner-primary"></span>
                    </div>
                {:else if messages.length === 0}
                    <p class="text-surface-500 text-sm text-center py-8">
                        {m.chat_no_messages()}
                    </p>
                {:else}
                    {#each messages as msg (msg.id)}
                        {#if msg.messageType === 'system'}
                            <!-- System message (watch announcement) -->
                            <div class="group center gap-2 py-1">
                                <div
                                    class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-success-500/10 border border-success-500/20">
                                    <Icon src={Eye} class="w-3.5 h-3.5 text-success-400" />
                                    <span class="text-xs text-success-300">
                                        <span class="font-medium"
                                            >{msg.author.displayName ?? ''}</span>
                                        {msg.message}
                                    </span>
                                    <span class="text-xs text-surface-500"
                                        >{formatTime(msg.createdAt)}</span>
                                </div>
                                {#if canDelete(msg)}
                                    <button
                                        type="button"
                                        class="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity
                                               hover:bg-error-500/20 text-error-400"
                                        onclick={() => deleteMessage(msg.id)}
                                        disabled={deleting === msg.id}
                                        title={m.chat_delete_message()}>
                                        {#if deleting === msg.id}
                                            <span
                                                class="loading-spinner loading-spinner-error w-3 h-3"
                                            ></span>
                                        {:else}
                                            <Icon src={Trash} class="w-3 h-3" />
                                        {/if}
                                    </button>
                                {/if}
                            </div>
                        {:else}
                            <!-- User message -->
                            <div
                                class="group flex gap-2 {msg.author.userId === currentUser
                                    ? 'flex-row-reverse'
                                    : ''}">
                                <!-- Avatar -->
                                <div
                                    class="shrink-0 w-8 h-8 rounded-full overflow-hidden bg-surface-600 relative">
                                    <!-- Initials fallback (behind image) -->
                                    <span
                                        class="absolute inset-0 center text-xs text-surface-400 font-medium">
                                        {(msg.author.displayName ?? '').slice(0, 1).toUpperCase()}
                                    </span>
                                    <!-- Avatar image (on top, with solid background) -->
                                    <img
                                        src={msg.author.images.primary.href}
                                        alt={msg.author.userId}
                                        class="absolute inset-0 w-full h-full object-cover bg-surface-600"
                                        onerror={handleImageError} />
                                </div>

                                <!-- Message bubble -->
                                <div
                                    class="flex-1 min-w-0 {msg.author.userId === currentUser
                                        ? 'text-right'
                                        : ''}">
                                    <div class="inline-block max-w-[85%] text-left">
                                        <div
                                            class="flex items-center gap-2 mb-0.5 {msg.author
                                                .userId === currentUser
                                                ? 'flex-row-reverse'
                                                : ''}">
                                            <span class="text-xs font-medium text-surface-300">
                                                {msg.author.userId === currentUser
                                                    ? m.chat_you()
                                                    : (msg.author.displayName ?? '')}
                                            </span>
                                            <span class="text-xs text-surface-500"
                                                >{formatTime(msg.createdAt)}</span>
                                        </div>
                                        <div class="relative">
                                            <p
                                                class="px-3 py-2 rounded-lg text-sm break-words
                                                {msg.author.userId === currentUser
                                                    ? 'bg-primary-600/30 text-surface-100'
                                                    : 'bg-surface-700 text-surface-200'}">
                                                {msg.message}
                                            </p>

                                            <!-- Delete button -->
                                            {#if canDelete(msg)}
                                                <button
                                                    type="button"
                                                    class="absolute top-1/2 -translate-y-1/2 p-1 rounded
                                                           opacity-0 group-hover:opacity-100 transition-opacity
                                                           hover:bg-error-500/20 text-error-400
                                                           {msg.author.userId === currentUser
                                                        ? '-left-7'
                                                        : '-right-7'}"
                                                    onclick={() => deleteMessage(msg.id)}
                                                    disabled={deleting === msg.id}
                                                    title={m.chat_delete_message()}>
                                                    {#if deleting === msg.id}
                                                        <span
                                                            class="loading-spinner loading-spinner-error w-4 h-4"
                                                        ></span>
                                                    {:else}
                                                        <Icon src={Trash} class="w-4 h-4" />
                                                    {/if}
                                                </button>
                                            {/if}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        {/if}
                    {/each}
                {/if}
            </div>

            <!-- Input area -->
            <div class="p-3 border-t border-surface-700">
                <form onsubmit={preventDefault(sendMessage)} class="flex gap-2">
                    <input
                        type="text"
                        class="input flex-1 text-sm"
                        aria-label={m.chat_placeholder()}
                        placeholder={m.chat_placeholder()}
                        bind:value={newMessage}
                        onkeydown={handleKeydown}
                        maxlength="1000"
                        disabled={sending} />
                    <button
                        type="submit"
                        aria-label={m.annotations_chat_send()}
                        class="btn variant-filled-primary btn-sm"
                        disabled={!newMessage.trim() || sending}>
                        {#if sending}
                            <span class="loading-spinner loading-spinner-white"></span>
                        {:else}
                            <Icon src={PaperAirplane} class="w-4 h-4" />
                        {/if}
                    </button>
                </form>
            </div>
        </div>
    {/if}
</div>
