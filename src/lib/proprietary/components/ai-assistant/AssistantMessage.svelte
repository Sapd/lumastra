<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * ChatMessage - Individual chat message bubble
     * Handles both user and assistant message rendering
     * Intercepts internal links (Jellyfin/Jellyseerr) and dispatches events
     */
    import {
        Icon,
        Sparkles,
        ChatBubbleOvalLeft,
        ClipboardDocument,
        CheckCircle,
        ArrowPath,
    } from 'svelte-hero-icons';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import { formatTimeOnly } from '$lib/utils/time-formatting';
    import {
        parseMarkdownLinks,
        linkifyTitles,
        resolveMovieByRef,
    } from '$lib/utils/assistant-utils';
    import { sanitizeAssistantHtml } from './assistant-sanitize';
    import { browser } from '$app/environment';
    import * as m from '$lib/paraglide/messages';
    import type { Message, RecommendedMovie } from '$lib/types/assistant';

    interface Props {
        message: Message;
        userAvatarSrc?: string;
        /** Username for deterministic colored SVG avatar fallback */
        username?: string;
        chatbotName?: string;
        chatbotAvatar?: string;
        // Callbacks
        onjellyfinLink?: (detail: { jellyfinId: string }) => void;
        onjellyseerrLink?: (detail: {
            externalId: string;
            externalProvider: string;
            mediaType: string;
        }) => void;
        /** Open the media modal for a recommended title clicked in the prose. */
        onmovieClick?: (detail: { movie: RecommendedMovie }) => void;
        /** Show a Retry affordance (only the most recent failed-send bubble sets this). */
        showRetry?: boolean;
        onretry?: () => void;
    }

    let {
        message,
        userAvatarSrc = '',
        username,
        chatbotName = '',
        chatbotAvatar = '',
        onjellyfinLink,
        onjellyseerrLink,
        onmovieClick,
        showRetry = false,
        onretry,
    }: Props = $props();

    let displayName = $derived(chatbotName || 'Assistant');
    let copied = $state(false);
    let copyResetTimeout: ReturnType<typeof setTimeout> | undefined;

    /** Rendered, sanitized HTML for this message — shared by the display markup and copy. */
    let renderedHtml = $derived(
        sanitizeAssistantHtml(
            linkifyTitles(parseMarkdownLinks(message.content), message.recommendedMovies ?? []),
        ),
    );

    /** Copy the message as plain text (strip markup) rather than the raw HTML/markdown. */
    async function copyMessage() {
        if (!browser) return;
        try {
            const div = document.createElement('div');
            div.innerHTML = renderedHtml;
            const plainText = div.textContent ?? message.content;
            await navigator.clipboard.writeText(plainText);
            copied = true;
            clearTimeout(copyResetTimeout);
            copyResetTimeout = setTimeout(() => {
                copied = false;
            }, 2000);
        } catch (err) {
            console.error('Failed to copy message:', err);
        }
    }

    /**
     * Handle clicks on internal links
     */
    function handleMessageClick(e: MouseEvent) {
        const target = e.target as HTMLElement;
        const link = target.closest('a[data-internal-link]') as HTMLAnchorElement | null;

        if (link) {
            e.preventDefault();
            const linkType = link.dataset.internalLink;

            if (linkType === 'modal') {
                // Prefer the model-cited ref (multilingual-safe); fall back to
                // the title-match index from linkifyTitles.
                const ref = link.dataset.ref;
                const movie = ref
                    ? resolveMovieByRef(message.recommendedMovies ?? [], ref)
                    : message.recommendedMovies?.[Number(link.dataset.movieIndex)];
                if (movie) {
                    onmovieClick?.({ movie });
                }
            } else if (linkType === 'jellyfin') {
                const jellyfinId = link.dataset.jellyfinId;
                if (jellyfinId) {
                    onjellyfinLink?.({ jellyfinId });
                }
            } else if (linkType === 'jellyseerr') {
                const externalId = link.dataset.externalId;
                const externalProvider = link.dataset.externalProvider || 'tmdb';
                const mediaType = link.dataset.mediaType;
                if (externalId && mediaType) {
                    onjellyseerrLink?.({
                        externalId,
                        externalProvider,
                        mediaType,
                    });
                }
            }
        }
    }
</script>

<div class="message {message.role}">
    {#if message.role === 'user'}
        <div class="flex justify-end gap-3 items-start">
            <div
                class="message-bubble user-message bg-primary-600 text-white rounded-2xl px-4 py-3 max-w-[70%]">
                <p class="whitespace-pre-wrap">{message.content}</p>
                <span class="text-xs opacity-70 mt-1 block"
                    >{formatTimeOnly(message.timestamp)}</span>
            </div>
            <div class="shrink-0">
                <Avatar
                    src={userAvatarSrc || ''}
                    alt={m.assistant_user_avatar_alt()}
                    initials="?"
                    {username}
                    size="sm"
                    border="border-2 border-primary-500" />
            </div>
        </div>
    {:else}
        <div class="flex justify-start gap-3 items-start">
            <div class="shrink-0">
                {#if chatbotAvatar}
                    <Avatar
                        src={chatbotAvatar || ''}
                        alt={m.assistant_ai_avatar_alt()}
                        initials="AI"
                        size="sm"
                        border="border-2 border-primary-500" />
                {:else}
                    <div
                        class="w-10 h-10 rounded-full bg-primary-500/20 border-2 border-primary-500 center">
                        <Icon src={ChatBubbleOvalLeft} class="w-5 h-5 text-primary-500" />
                    </div>
                {/if}
            </div>
            <div
                class="message-bubble assistant-message bg-surface-700 rounded-2xl px-4 py-3 max-w-[70%]">
                <div class="flex items-start gap-2 mb-2">
                    <Icon src={Sparkles} class="w-5 h-5 text-primary-500 shrink-0 mt-0.5" />
                    <span class="font-semibold text-primary-400">{displayName}</span>
                </div>
                {#if message.thinking}
                    <details class="reasoning mb-2">
                        <summary class="text-xs text-surface-400 cursor-pointer select-none"
                            >{m.assistant_reasoning()}</summary>
                        <p class="reasoning-text whitespace-pre-wrap text-xs text-surface-300 mt-1">
                            {message.thinking}
                        </p>
                    </details>
                {/if}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="prose prose-invert prose-sm max-w-none" onclick={handleMessageClick}>
                    <p class="message-content">
                        {@html renderedHtml}
                    </p>
                </div>
                <div class="flex items-center justify-between gap-2 mt-2">
                    <span class="text-xs text-surface-400"
                        >{formatTimeOnly(message.timestamp)}</span>
                    <div class="flex items-center gap-1">
                        {#if showRetry}
                            <button
                                type="button"
                                onclick={() => onretry?.()}
                                class="btn btn-sm variant-ghost-surface hover:variant-filled-surface flex items-center gap-1 px-2 py-1 text-xs">
                                <Icon src={ArrowPath} class="w-3.5 h-3.5" aria-hidden="true" />
                                {m.session_retry()}
                            </button>
                        {/if}
                        <button
                            type="button"
                            onclick={copyMessage}
                            class="btn-icon btn-icon-sm variant-ghost-surface hover:variant-filled-surface"
                            aria-label={copied ? m.assistant_copied() : m.assistant_copy()}
                            title={copied ? m.assistant_copied() : m.assistant_copy()}>
                            <Icon
                                src={copied ? CheckCircle : ClipboardDocument}
                                class="w-3.5 h-3.5"
                                aria-hidden="true" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    {/if}
</div>

<style>
    .prose p {
        margin: 0;
        line-height: 1.6;
    }

    .message-content :global(a) {
        color: var(--color-primary-400);
        text-decoration: underline;
        transition: color 0.2s;
    }

    .message-content :global(a:hover) {
        color: var(--color-primary-300);
    }

    .message-content :global(strong) {
        font-weight: 600;
    }
</style>
