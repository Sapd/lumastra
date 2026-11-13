<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * Chat - Configurable AI chat interface
     * Orchestrates chat state, fetching, and delegates rendering to sub-components
     */
    import { onMount, tick } from 'svelte';
    import { goto } from '$app/navigation';
    import { browser } from '$app/environment';
    import {
        Icon,
        PaperAirplane,
        Sparkles,
        ExclamationTriangle,
        ChevronLeft,
        ChevronRight,
        ChevronDown,
        ChevronUp,
        ChatBubbleOvalLeft,
        Plus,
        Stop,
    } from 'svelte-hero-icons';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import { preventDefault } from '$lib/utils/event-helpers';
    import { getRandomLoadingMessage } from '$lib/utils/assistant-utils';
    import { dragScroll } from '$lib/utils/drag-scroll';
    import { page } from '$app/stores';
    import { env } from '$env/dynamic/public';
    import { openMediaModal, handleRequestAction } from '$lib/utils/modal-utils';
    import { navigateToWatch } from '$lib/stores/watch-navigation';
    import { getPreferredExternalId } from '$lib/utils/external-ids';
    import { buildMediaKey } from '$lib/utils/media-id-helpers';
    import * as aiApi from '$lib/api/ai';
    import * as userApi from '$lib/api/user';
    import * as m from '$lib/paraglide/messages';

    let appName = $derived($page.data?.branding?.appName || 'Dashboard');
    let chatbotName = $derived($page.data?.chatbot?.name || 'Assistant');
    let chatbotAvatar = $derived($page.data?.chatbot?.avatar || '');
    let requestsEnabled = $derived($page.data?.features?.requests === true);
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    // Sub-components
    import AssistantMessage from './ai-assistant/AssistantMessage.svelte';
    import AssistantRecommendationCard from './ai-assistant/AssistantRecommendationCard.svelte';
    import AssistantWelcome from './ai-assistant/AssistantWelcome.svelte';
    import AssistantOpener from './ai-assistant/AssistantOpener.svelte';

    // Types
    import type {
        Message,
        RateLimit,
        RecommendedMovie,
        RecommendedMusic,
    } from '$lib/types/assistant';
    import AssistantMusicRow from './ai-assistant/AssistantMusicRow.svelte';

    interface Props {
        // Accept initial question from URL query parameter
        initialQuestion?: string;
    }

    let { initialQuestion = '' }: Props = $props();

    // =========================================================================
    // State
    // =========================================================================

    const MAX_MESSAGE_LENGTH = 5000;
    const CHAR_COUNTER_THRESHOLD = 4000;
    /** localStorage key: ISO cutoff so a "New chat"-cleared conversation stays cleared across reloads. */
    const HISTORY_CUTOFF_KEY = 'assistant:historyCutoff';

    let messages: Message[] = $state([]);
    let inputMessage = $state('');
    let isLoading = $state(false);
    let rateLimit = $state<RateLimit | null>(null);
    /** User text of the most recent send failure, kept so the Retry affordance can resend it. */
    let lastFailedMessage = $state<string | null>(null);

    // ── Streaming state ──────────────────────────────────────────────────────
    /** A live SSE stream is in progress (drives the Stop button + streaming bubble). */
    let isStreaming = $state(false);
    /** Accumulating text of the CURRENT model round (earlier rounds are preamble, cleared). */
    let streamingText = $state('');
    /** Accumulating model reasoning summary shown live during streaming. */
    let streamingThinking = $state('');
    /** Localized status line under the pending bubble (tool label / "Thinking…"). */
    let statusLabel = $state('');
    /** Model round number currently being streamed — a new round clears preamble text. */
    let currentRound = 0;
    /** Flips true on the first status/delta so the rotating flavor message stops. */
    let activityStarted = $state(false);
    /** Aborts the in-flight streaming fetch when the user presses Stop. */
    let abortController: AbortController | undefined;
    /** Gate: only announce assistant replies to the live region AFTER a user send in-session
     *  (so restored history is never announced on mount). */
    let announceReplies = $state(false);
    /** Gate the welcome screen until history resolves (or times out) — avoids a welcome flash. */
    let showWelcome = $state(false);
    let chatContainer: HTMLDivElement | undefined = $state();
    let scrollAnchor: HTMLDivElement | undefined = $state();
    let textareaElement: HTMLTextAreaElement | undefined = $state();
    let moviesScrollContainer: HTMLDivElement | undefined = $state();
    let sidebarScrollContainer: HTMLDivElement | undefined = $state();
    let userAvatarSrc: string = $state('');
    let userId: string = '';
    let shouldAutoScroll = $state(true);
    let loadingMessage = $state('');
    let isRecommendationsCollapsed = $state(false);
    let previousRecommendationsKey = '';
    /** Two-step confirm for clearing the conversation (click once to arm, again to confirm). */
    let confirmingNewChat = $state(false);
    let confirmingNewChatTimeout: ReturnType<typeof setTimeout> | undefined;
    /** Visually-hidden live region announcing loading state + new assistant replies. */
    let liveRegionMessage = $state('');

    const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null;

    // =========================================================================
    // Scroll handling
    // =========================================================================

    function scrollMoviesLeft() {
        if (moviesScrollContainer) {
            moviesScrollContainer.scrollBy({ left: -200, behavior: 'smooth' });
        }
    }

    function scrollMoviesRight() {
        if (moviesScrollContainer) {
            moviesScrollContainer.scrollBy({ left: 200, behavior: 'smooth' });
        }
    }

    // Auto-scroll to bottom when new messages arrive using scroll anchor pattern
    let lastMessageCount = $state(0);
    $effect.pre(() => {
        if (messages.length > lastMessageCount && shouldAutoScroll) {
            lastMessageCount = messages.length;
            tick().then(() => {
                if (scrollAnchor && shouldAutoScroll) {
                    scrollAnchor.scrollIntoView({ behavior: 'smooth' });
                }
            });
        }
    });

    // Announce loading state and new assistant replies to screen readers via the
    // aria-live region rendered below (a11y: users relying on SR don't otherwise
    // learn a reply arrived without scanning the transcript).
    $effect(() => {
        if (isLoading) {
            liveRegionMessage = loadingMessage;
            return;
        }
        // Never announce restored history — only replies to an in-session send.
        if (!announceReplies) return;
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
            liveRegionMessage = m.assistant_new_message_announcement({ name: chatbotName });
        }
    });

    /**
     * Text for the streaming bubble's status line. Rotating flavor message only
     * for the initial pre-activity wait; once a status/delta arrives, show the
     * real tool status (or "Thinking…" while a round has no text yet). Empty when
     * text is streaming and no tool is running (the text itself is the feedback).
     */
    let streamingStatusText = $derived(
        !activityStarted
            ? loadingMessage
            : statusLabel
              ? statusLabel
              : streamingText
                ? ''
                : m.assistant_status_thinking(),
    );

    // Keep the streaming bubble pinned to the bottom as text/status grows (the
    // message-count auto-scroll effect doesn't fire while a single bubble grows).
    $effect(() => {
        // Touch the reactive streaming fields so this re-runs as they change.
        void streamingText;
        void streamingThinking;
        void statusLabel;
        if (isStreaming && shouldAutoScroll && scrollAnchor) {
            scrollAnchor.scrollIntoView({ behavior: 'auto' });
        }
    });

    // Detect if user is scrolling manually
    let isScrolling = false;
    function handleScroll() {
        if (!chatContainer || isScrolling) return;

        const threshold = 50;
        const position =
            chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
        const wasAutoScroll = shouldAutoScroll;
        shouldAutoScroll = position < threshold;

        if (wasAutoScroll && !shouldAutoScroll) {
            isScrolling = true;
            setTimeout(() => {
                isScrolling = false;
            }, 100);
        }
    }

    // =========================================================================
    // Data loading
    // =========================================================================

    onMount(async () => {
        // Snappy: let the welcome/suggestions appear if history is slow or fails,
        // rather than blocking behind a spinner.
        const welcomeTimer = setTimeout(() => {
            showWelcome = true;
        }, 1000);

        // Rate limit + avatar load in parallel with history (independent state).
        void loadRateLimitStatus();
        void loadUserAvatar();

        if (initialQuestion) {
            // Auto-send pending → skip history restore entirely.
            clearTimeout(welcomeTimer);
            showWelcome = true;
            inputMessage = initialQuestion;
            setTimeout(() => sendMessage(), 100);
            return;
        }

        await restoreHistory();
        clearTimeout(welcomeTimer);
        showWelcome = true;
    });

    /**
     * Hydrate the transcript from persisted history on reload. Text-only (no
     * cards). Honors the "New chat" cutoff so cleared conversations stay cleared.
     * History errors are non-fatal and silent to the user.
     */
    async function restoreHistory() {
        try {
            const cutoff = browser ? localStorage.getItem(HISTORY_CUTOFF_KEY) : null;
            const { data, error: historyError } = await aiApi.getAssistantHistory(
                50,
                cutoff ?? undefined,
            );
            if (!historyError && data?.messages?.length) {
                // Restored assistant content is processed through the same
                // markdown/sanitize path (in AssistantMessage) as live messages,
                // but with an empty cards array — ref links resolve to nothing.
                messages = data.messages.map((msg) => ({
                    role: msg.role,
                    content: msg.content,
                    timestamp: new Date(msg.createdAt),
                    recommendedMovies: [],
                    recommendedMusic: [],
                }));
                lastMessageCount = messages.length; // suppress smooth auto-scroll of restored history
            }
        } catch (err) {
            // Non-fatal: a failed history fetch just shows the welcome screen.
            console.error('Failed to restore assistant history:', err);
        }
    }

    async function loadUserAvatar() {
        try {
            const { data, error: userError } = await userApi.getUser();
            if (!userError && data) {
                userId = data.id || '';
                if (userId) {
                    userAvatarSrc = getAvatarUrl(data.images?.primary ?? userId);
                }
            }
        } catch (err) {
            console.error('Failed to load user avatar:', err);
        }
    }

    async function loadRateLimitStatus() {
        try {
            const { data, error: rateLimitError } = await aiApi.getAssistantRateLimit();
            if (!rateLimitError && data) {
                rateLimit = {
                    remaining: data.remaining,
                    limit: data.limit,
                    isAdmin: data.isAdmin,
                };
            }
        } catch (err) {
            console.error('Failed to load rate limit status:', err);
        }
    }

    // =========================================================================
    // Message handling
    // =========================================================================

    /**
     * Start a fresh conversation: clears history (and the recommended cards).
     * Destructive once there's history, so it's gated behind a two-step inline
     * confirm (click arms it, a second click within a few seconds confirms).
     */
    function newConversation() {
        if (isLoading) return;

        if (messages.length > 0 && !confirmingNewChat) {
            confirmingNewChat = true;
            clearTimeout(confirmingNewChatTimeout);
            confirmingNewChatTimeout = setTimeout(() => {
                confirmingNewChat = false;
            }, 3000);
            return;
        }

        clearTimeout(confirmingNewChatTimeout);
        confirmingNewChat = false;
        messages = [];
        lastFailedMessage = null;
        inputMessage = '';
        shouldAutoScroll = true;
        announceReplies = false;
        // Persist a cutoff so this cleared conversation stays cleared across reloads.
        if (browser) {
            try {
                localStorage.setItem(HISTORY_CUTOFF_KEY, new Date().toISOString());
            } catch {
                /* localStorage may be unavailable (private mode / quota) — non-fatal */
            }
        }
    }

    /** True for an abort (user pressed Stop / signal aborted) vs a real error. */
    function isAbortError(err: unknown): boolean {
        return (
            (err instanceof DOMException && err.name === 'AbortError') ||
            (err instanceof Error && err.name === 'AbortError')
        );
    }

    /** Map a backend tool name to a localized, friendly "doing X…" status label. */
    function toolStatusLabel(tool: string): string {
        switch (tool) {
            case 'search_library':
                return m.assistant_status_search_library();
            case 'get_recommendations':
                return m.assistant_status_get_recommendations();
            case 'check_availability':
                return m.assistant_status_check_availability();
            case 'get_details':
                return m.assistant_status_get_details();
            case 'whats_on_tv':
                return m.assistant_status_whats_on_tv();
            case 'search_music':
                return m.assistant_status_search_music();
            case 'get_music_picks':
                return m.assistant_status_get_music_picks();
            case 'get_top_music':
                return m.assistant_status_get_top_music();
            case 'find_by_person':
                return m.assistant_status_find_by_person();
            case 'browse_by_genre':
                return m.assistant_status_browse_by_genre();
            case 'browse_by_keyword':
                return m.assistant_status_browse_by_keyword();
            case 'get_watch_history':
                return m.assistant_status_get_watch_history();
            case 'get_watchlist':
                return m.assistant_status_get_watchlist();
            case 'get_my_ratings':
                return m.assistant_status_get_my_ratings();
            default:
                return m.assistant_status_generic();
        }
    }

    /** Reset all per-send streaming accumulators. */
    function resetStreamingState() {
        streamingText = '';
        streamingThinking = '';
        statusLabel = '';
        currentRound = 0;
        activityStarted = false;
    }

    /**
     * Handle a `status` frame. A new model round clears the accumulated in-progress
     * text (earlier-round text was preamble before tool calls); a tool round shows
     * a friendly localized label.
     */
    function handleStreamStatus(status: { phase: 'model' | 'tool'; round: number; tool?: string }) {
        activityStarted = true;
        if (status.phase === 'model') {
            if (status.round !== currentRound) {
                currentRound = status.round;
                streamingText = '';
            }
            statusLabel = '';
        } else {
            statusLabel = toolStatusLabel(status.tool ?? '');
        }
    }

    /** Commit the authoritative streamed/non-streamed response as a permanent bubble. */
    function finalizeAssistantResponse(data: {
        response: string;
        thinking?: string;
        recommendedMovies?: RecommendedMovie[];
        recommendedMusic?: RecommendedMusic[];
        rateLimit?: RateLimit;
    }) {
        messages = [
            ...messages,
            {
                role: 'assistant',
                content: data.response,
                thinking: data.thinking,
                timestamp: new Date(),
                recommendedMovies: data.recommendedMovies || [],
                recommendedMusic: data.recommendedMusic || [],
            },
        ];
        if (data.rateLimit) {
            rateLimit = data.rateLimit;
        }
    }

    /** Surface a failed send as an assistant error bubble + restore input for Retry. */
    function showErrorBubble(errorMessage: string, userMessage: string) {
        showNoticeBubble(m.assistant_error_sending_detail({ error: errorMessage }), userMessage);
    }

    /** Show `content` as an assistant bubble and restore the input for Retry. */
    function showNoticeBubble(content: string, userMessage: string) {
        lastFailedMessage = userMessage;
        inputMessage = userMessage;
        messages = [...messages, { role: 'assistant', content, timestamp: new Date() }];
    }

    /**
     * Commit a user-stopped stream: keep whatever text already streamed and mark it
     * with a subtle localized "(stopped)" suffix. No error bubble, no input restore.
     */
    function finalizeStopped() {
        const streamed = streamingText.trim();
        const marker = `*${m.assistant_stopped()}*`; // italic → subtle
        const content = streamed ? `${streamed}\n\n${marker}` : marker;
        messages = [
            ...messages,
            {
                role: 'assistant',
                content,
                thinking: streamingThinking || undefined,
                timestamp: new Date(),
                recommendedMovies: [],
                recommendedMusic: [],
            },
        ];
    }

    /**
     * One-time fallback to the non-streaming endpoint (for older deployments /
     * proxies without SSE). Only reached when the stream failed with a network-ish
     * error BEFORE any frame arrived.
     */
    async function sendNonStreamingFallback(
        userMessage: string,
        history: Array<{ role: 'user' | 'assistant'; content: string }>,
    ) {
        // The fallback request cannot be aborted (plain JSON POST) — drop the
        // streaming state so the Stop button doesn't render as a dead control.
        isStreaming = false;
        try {
            const { data, error: chatError } = await aiApi.sendAssistantMessage(
                userMessage,
                history,
            );
            if (chatError) throw new Error(chatError);
            if (data) finalizeAssistantResponse(data);
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            console.error('Chat fallback error:', err);
            showErrorBubble(errorMessage, userMessage);
        }
    }

    async function sendMessage() {
        if (!inputMessage.trim() || isLoading) return;
        if (inputMessage.length > MAX_MESSAGE_LENGTH) return;

        const userMessage = inputMessage.trim();
        inputMessage = '';
        lastFailedMessage = null;
        shouldAutoScroll = true;
        announceReplies = true;

        // Recent conversation context (the turns BEFORE this new message), so
        // the assistant can follow up on "yes!", "the first one", etc. Capped.
        const history = messages.slice(-10).map((msg) => ({
            role: msg.role,
            content: msg.content,
        }));

        messages = [
            ...messages,
            {
                role: 'user',
                content: userMessage,
                timestamp: new Date(),
            },
        ];

        isLoading = true;
        isStreaming = true;
        resetStreamingState();
        loadingMessage = getRandomLoadingMessage();

        abortController = new AbortController();
        // Any status/text/thinking frame means the SSE transport works — used to
        // decide whether a later failure is worth a non-streaming fallback.
        let sawFrame = false;
        // Boxed (not bare lets): TS doesn't track assignments made inside the
        // stream callbacks (microsoft/TypeScript#9998) and would keep bare
        // locals narrowed to their initial null (→ `never` on property reads).
        const outcome: {
            done: Parameters<typeof finalizeAssistantResponse>[0] | null;
            error: { message: string; status?: number } | null;
        } = { done: null, error: null };

        try {
            await aiApi.sendAssistantMessageStream(
                { message: userMessage, history },
                {
                    onStatus: (status) => {
                        sawFrame = true;
                        handleStreamStatus(status);
                    },
                    onText: (delta) => {
                        sawFrame = true;
                        activityStarted = true;
                        statusLabel = '';
                        streamingText += delta;
                    },
                    onThinking: (delta) => {
                        sawFrame = true;
                        activityStarted = true;
                        streamingThinking += delta;
                    },
                    onDone: (data) => {
                        outcome.done = data;
                    },
                    onError: (err) => {
                        outcome.error = err;
                    },
                },
                abortController.signal,
            );

            if (outcome.done) {
                finalizeAssistantResponse(outcome.done);
            } else if (outcome.error?.status === 429) {
                // A limit, not a fault. The server does not say which one, so
                // re-read the budget: zero left means the daily budget ran out
                // during this send; otherwise it was the per-minute limit.
                await loadRateLimitStatus();
                if (rateLimit && !rateLimit.isAdmin && rateLimit.remaining <= 0) {
                    showNoticeBubble(m.assistant_daily_budget_reached(), userMessage);
                } else {
                    showNoticeBubble(m.assistant_error_too_fast(), userMessage);
                }
            } else if (outcome.error) {
                // HTTP-status rejection or an `error` frame — NOT a fallback case.
                showErrorBubble(outcome.error.message, userMessage);
            } else {
                // Stream ended with neither a done nor an error frame (unexpected).
                showErrorBubble(m.assistant_error_sending(), userMessage);
            }
        } catch (err) {
            if (isAbortError(err)) {
                // User pressed Stop — keep the partial text, mark it stopped.
                finalizeStopped();
            } else if (!sawFrame) {
                // Network-ish failure before the stream produced anything → fall
                // back once to the non-streaming endpoint.
                console.warn(
                    'Assistant stream failed pre-frame; falling back to non-streaming',
                    err,
                );
                await sendNonStreamingFallback(userMessage, history);
            } else {
                // Transport dropped mid-stream after frames arrived — surface as error.
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                console.error('Chat stream error:', err);
                showErrorBubble(errorMessage, userMessage);
            }
        } finally {
            isStreaming = false;
            isLoading = false;
            statusLabel = '';
            abortController = undefined;
        }
    }

    /** Abort the in-flight streaming request (Stop button). */
    function stopStreaming() {
        abortController?.abort();
    }

    /** Resend the most recently failed message (invoked from the error bubble's Retry button). */
    function retryLastMessage() {
        if (!lastFailedMessage || isLoading) return;
        inputMessage = lastFailedMessage;
        void sendMessage();
    }

    function handleKeyPress(e: KeyboardEvent) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    }

    /**
     * Set a suggested question and focus the textarea
     */
    function setQuestion(text: string) {
        inputMessage = text;
        tick().then(() => {
            textareaElement?.focus();
        });
    }

    // =========================================================================
    // Recommendations
    // =========================================================================

    function getLatestRecommendations(msgs: Message[]): RecommendedMovie[] {
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant' && msgs[i].recommendedMovies?.length) {
                return msgs[i].recommendedMovies!;
            }
        }
        return [];
    }

    let currentRecommendations = $derived(getLatestRecommendations(messages));

    function getLatestMusic(msgs: Message[]): RecommendedMusic[] {
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant' && msgs[i].recommendedMusic?.length) {
                return msgs[i].recommendedMusic!;
            }
        }
        return [];
    }

    let currentMusic = $derived(getLatestMusic(messages));

    // Auto-expand + rewind the rail when a NEW set of recommendations arrives.
    // Keyed on the card set (not just the count): a follow-up turn can return
    // the same number of cards, and a stale horizontal scroll offset would
    // otherwise hide the fresh, first-placed suggestions.
    $effect(() => {
        const key = currentRecommendations.map((r) => `${r.title}:${r.mediaType}`).join('|');
        if (currentRecommendations.length > 0 && key !== previousRecommendationsKey) {
            isRecommendationsCollapsed = false;
            previousRecommendationsKey = key;
            moviesScrollContainer?.scrollTo({ left: 0 });
            sidebarScrollContainer?.scrollTo({ top: 0 });
        } else if (currentRecommendations.length === 0) {
            previousRecommendationsKey = '';
        }
    });

    function toggleRecommendations() {
        isRecommendationsCollapsed = !isRecommendationsCollapsed;
    }

    // =========================================================================
    // Recommendation Card Event Handlers
    // =========================================================================

    function handleMoviePlay(detail: { movie: RecommendedMovie }) {
        const movie = detail.movie;
        const playableId = movie.externalIds?.internal;
        if (browser && playableId) {
            const key = buildMediaKey(movie.externalIds, movie.mediaType) ?? playableId;
            void navigateToWatch(key);
        }
    }

    function handleMovieRequest(detail: { movie: RecommendedMovie }) {
        const movie = detail.movie;
        handleRequestAction(
            {
                externalIds: movie.externalIds,
                mediaType: movie.mediaType,
                title: movie.title,
                posterPath: '', // Will be fetched by the modal
                year: movie.releaseDate?.substring(0, 4) || '',
            },
            requestsEnabled,
            env.PUBLIC_REQUESTURL || '',
            hasRequestPermission,
        );
    }

    /** Compact token formatting for the daily-budget display (e.g. 250000 -> "250k"). */
    function formatTokens(n: number): string {
        return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
    }

    function handleMovieClick(detail: { movie: RecommendedMovie }) {
        const movie = detail.movie;
        openMediaModal(
            {
                externalIds: movie.externalIds,
                mediaType: movie.mediaType,
                title: movie.title,
                overview: movie.overview || '',
                rating: movie.imdbRating || 0,
                isAvailable: movie.isAvailable,
                genres: movie.genres || [],
                criticRating: movie.rtRating,
            },
            '', // posterUrl - will be generated from externalIds
        );
    }

    // =========================================================================
    // Message Link Event Handlers
    // =========================================================================

    function handleJellyfinLink(detail: { jellyfinId: string }) {
        const { jellyfinId } = detail;
        if (browser && jellyfinId) {
            void navigateToWatch(jellyfinId);
        }
    }

    function handleJellyseerrLink(detail: {
        externalId: string;
        externalProvider: string;
        mediaType: string;
    }) {
        const { externalId, externalProvider, mediaType } = detail;
        // Jellyseerr requires TMDB ID - only proceed if provider is TMDB
        if (externalProvider !== 'tmdb') {
            console.warn('Seerr only supports TMDB IDs, got:', externalProvider);
            return;
        }
        handleRequestAction(
            {
                externalIds: { [externalProvider]: externalId },
                mediaType: mediaType as 'movie' | 'tv',
                title: '', // Title not available from link
                posterPath: '',
                year: '',
            },
            requestsEnabled,
            env.PUBLIC_REQUESTURL || '',
            hasRequestPermission,
        );
    }
</script>

<div class="chat-container flex flex-col h-full">
    <!-- Screen-reader announcements for loading state changes + new assistant replies.
         Persistently in the DOM (sr-only) so updates are reliably announced. -->
    <div class="sr-only" aria-live="polite" role="status">{liveRegionMessage}</div>

    <!-- Header -->
    <div class="chat-header bg-surface-800 border-b border-surface-700 p-4 between">
        <div class="flex items-center gap-3">
            {#if chatbotAvatar}
                <Avatar
                    src={chatbotAvatar || ''}
                    alt={m.assistant_ai_avatar_alt()}
                    initials="AI"
                    size="md"
                    border="border-2 border-primary-500" />
            {:else}
                <div
                    class="w-12 h-12 rounded-full bg-primary-500/20 border-2 border-primary-500 center">
                    <Icon src={ChatBubbleOvalLeft} class="w-6 h-6 text-primary-500" />
                </div>
            {/if}
            <div>
                <h2 class="text-xl font-bold">{chatbotName}</h2>
                <p class="text-sm text-surface-400">
                    {m.assistant_entertainment_database_subtitle({ appName })}
                </p>
            </div>
        </div>

        <!-- Right side: new conversation + rate limit -->
        <div class="flex items-center gap-3">
            {#if messages.length > 0}
                <button
                    type="button"
                    onclick={newConversation}
                    onblur={() => (confirmingNewChat = false)}
                    disabled={isLoading}
                    class="btn btn-sm flex items-center gap-1 {confirmingNewChat
                        ? 'variant-filled-error'
                        : 'variant-ghost-surface hover:variant-filled-surface'}"
                    aria-label={confirmingNewChat
                        ? m.assistant_new_chat_confirm_aria()
                        : m.assistant_new_chat_aria()}>
                    <Icon src={Plus} class="w-4 h-4" aria-hidden="true" />
                    <span class="hidden sm:inline">
                        {confirmingNewChat
                            ? m.assistant_new_chat_confirm()
                            : m.assistant_new_chat()}
                    </span>
                </button>
            {/if}
            <!-- Rate Limit Display -->
            {#if rateLimit}
                <div class="flex items-center gap-2 text-sm">
                    {#if rateLimit.isAdmin}
                        <span class="badge variant-filled-success"
                            >{m.assistant_admin_badge()}</span>
                    {/if}
                    <span class="text-surface-400">
                        {m.assistant_tokens_left_ratio({
                            remaining: formatTokens(rateLimit.remaining),
                            limit: formatTokens(rateLimit.limit),
                        })}
                    </span>
                    {#if rateLimit.remaining > 0 && rateLimit.remaining < rateLimit.limit * 0.1}
                        <Icon src={ExclamationTriangle} class="w-5 h-5 text-warning-500" />
                    {:else if rateLimit.remaining === 0}
                        <Icon src={ExclamationTriangle} class="w-5 h-5 text-error-500" />
                    {/if}
                </div>
            {/if}
        </div>
    </div>

    <!-- Body: chat column + (xl+) suggestions sidebar. Below xl the
         suggestions render as the horizontal bottom rail inside the chat
         column instead — one source of truth (currentRecommendations),
         CSS-breakpoint switching only. -->
    <div class="flex flex-1 min-h-0">
        <div class="flex flex-col flex-1 min-w-0">
            <!-- Sits ABOVE the scroll container on purpose: it must be visible
                 whether the thread is empty or restored, and it must not scroll
                 away with the messages. Never appended to `messages` — a real
                 chat bubble would be persisted and replayed to the model next
                 turn as something the assistant had said. -->
            <AssistantOpener
                name={$page.data?.user?.username ?? ''}
                dismissalScope={$page.data?.user?.username ?? 'anon'}
                onsuggestionSelected={setQuestion} />

            <!-- Messages Container -->
            <div
                bind:this={chatContainer}
                onscroll={handleScroll}
                class="chat-messages flex-1 overflow-y-auto p-4 space-y-4">
                {#if messages.length === 0}
                    <!-- Gate the welcome behind the history fetch to avoid a welcome flash
                 before a restored conversation arrives (or a ~1s timeout / error). -->
                    {#if showWelcome}
                        <AssistantWelcome
                            {chatbotName}
                            {chatbotAvatar}
                            onquestionSelected={setQuestion} />
                    {/if}
                {:else}
                    <!-- Chat Messages -->
                    <!-- Key includes the index: restored history rows can share a
                         same-millisecond created_at (user+assistant inserted
                         back-to-back), and duplicate keys crash the each block. -->
                    {#each messages as message, messageIdx (`${message.timestamp.getTime()}-${messageIdx}`)}
                        <AssistantMessage
                            {message}
                            {userAvatarSrc}
                            username={$page.data?.user?.username}
                            {chatbotName}
                            {chatbotAvatar}
                            showRetry={messageIdx === messages.length - 1 &&
                                lastFailedMessage !== null &&
                                !isLoading}
                            onretry={retryLastMessage}
                            onjellyfinLink={handleJellyfinLink}
                            onjellyseerrLink={handleJellyseerrLink}
                            onmovieClick={handleMovieClick} />
                    {/each}

                    <!-- Streaming bubble: progressively renders the assistant reply.
                 Text is shown as plain (raw) text while streaming; the final,
                 markdown/HTML-processed answer is swapped in as a real message on
                 `done` (see finalizeAssistantResponse). -->
                    {#if isStreaming}
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
                                        <Icon
                                            src={ChatBubbleOvalLeft}
                                            class="w-5 h-5 text-primary-500" />
                                    </div>
                                {/if}
                            </div>
                            <div
                                class="message-bubble assistant-message bg-surface-700 rounded-2xl px-4 py-3 max-w-[70%]">
                                <div class="flex items-start gap-2 mb-2">
                                    <Icon
                                        src={Sparkles}
                                        class="w-5 h-5 text-primary-500 shrink-0 mt-0.5" />
                                    <span class="font-semibold text-primary-400"
                                        >{chatbotName}</span>
                                </div>
                                {#if streamingThinking}
                                    <details class="reasoning mb-2" open>
                                        <summary
                                            class="text-xs text-surface-400 cursor-pointer select-none"
                                            >{m.assistant_reasoning()}</summary>
                                        <p
                                            class="reasoning-text whitespace-pre-wrap text-xs text-surface-300 mt-1">
                                            {streamingThinking}
                                        </p>
                                    </details>
                                {/if}
                                {#if streamingText}
                                    <p class="message-content whitespace-pre-wrap">
                                        {streamingText}
                                    </p>
                                {/if}
                                {#if streamingStatusText}
                                    <div
                                        class="flex items-center gap-2 text-surface-400 text-sm {streamingText
                                            ? 'mt-2'
                                            : ''}">
                                        <Icon
                                            src={Sparkles}
                                            class="w-4 h-4 text-primary-500 animate-pulse shrink-0" />
                                        <span>{streamingStatusText}</span>
                                        {#if !streamingText}
                                            <div class="flex gap-1">
                                                <div
                                                    class="w-2 h-2 bg-primary-500 rounded-full animate-bounce"
                                                    style="animation-delay: 0ms">
                                                </div>
                                                <div
                                                    class="w-2 h-2 bg-primary-500 rounded-full animate-bounce"
                                                    style="animation-delay: 150ms">
                                                </div>
                                                <div
                                                    class="w-2 h-2 bg-primary-500 rounded-full animate-bounce"
                                                    style="animation-delay: 300ms">
                                                </div>
                                            </div>
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                        </div>
                    {:else if isLoading}
                        <!-- Non-streaming fallback path (older deployments without SSE). -->
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
                                        <Icon
                                            src={ChatBubbleOvalLeft}
                                            class="w-5 h-5 text-primary-500" />
                                    </div>
                                {/if}
                            </div>
                            <div
                                class="message-bubble assistant-message bg-surface-700 rounded-2xl px-4 py-3">
                                <div class="flex items-center gap-2">
                                    <Icon
                                        src={Sparkles}
                                        class="w-5 h-5 text-primary-500 animate-pulse" />
                                    <span class="text-surface-400">{loadingMessage}</span>
                                    <div class="flex gap-1">
                                        <div
                                            class="w-2 h-2 bg-primary-500 rounded-full animate-bounce"
                                            style="animation-delay: 0ms">
                                        </div>
                                        <div
                                            class="w-2 h-2 bg-primary-500 rounded-full animate-bounce"
                                            style="animation-delay: 150ms">
                                        </div>
                                        <div
                                            class="w-2 h-2 bg-primary-500 rounded-full animate-bounce"
                                            style="animation-delay: 300ms">
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    {/if}

                    <!-- Scroll anchor for auto-scrolling -->
                    <div bind:this={scrollAnchor}></div>
                {/if}
            </div>

            <!-- Recommended Movies Cards — horizontal bottom rail (below xl only;
         xl+ shows the sidebar instead) -->
            {#if currentRecommendations.length > 0}
                <div
                    class="recommended-movies-section xl:hidden bg-surface-800 border-t border-surface-700 px-4 py-3">
                    <div class="between mb-2">
                        <div class="flex items-center gap-2">
                            <Icon src={Sparkles} class="w-4 h-4 text-primary-500" />
                            <h3 class="text-xs font-semibold text-primary-400">
                                {m.assistant_recommended_content({
                                    count: currentRecommendations.length,
                                })}
                            </h3>
                        </div>
                        <div class="flex items-center gap-1">
                            {#if !isRecommendationsCollapsed}
                                <button
                                    onclick={scrollMoviesLeft}
                                    class="btn btn-sm variant-ghost-surface p-1 hover:variant-filled-surface"
                                    aria-label={m.assistant_scroll_recommendations_left()}>
                                    <Icon src={ChevronLeft} class="w-5 h-5" aria-hidden="true" />
                                </button>
                                <button
                                    onclick={scrollMoviesRight}
                                    class="btn btn-sm variant-ghost-surface p-1 hover:variant-filled-surface"
                                    aria-label={m.assistant_scroll_recommendations_right()}>
                                    <Icon src={ChevronRight} class="w-5 h-5" aria-hidden="true" />
                                </button>
                            {/if}
                            <button
                                onclick={toggleRecommendations}
                                class="btn btn-sm variant-ghost-surface p-1 hover:variant-filled-surface"
                                aria-label={isRecommendationsCollapsed
                                    ? m.assistant_show_recommendations()
                                    : m.assistant_hide_recommendations()}
                                aria-expanded={!isRecommendationsCollapsed}>
                                <Icon
                                    src={isRecommendationsCollapsed ? ChevronDown : ChevronUp}
                                    class="w-5 h-5"
                                    aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                    {#if !isRecommendationsCollapsed}
                        <div
                            bind:this={moviesScrollContainer}
                            use:dragScroll
                            class="flex gap-2 overflow-x-auto pb-2 cursor-grab active:cursor-grabbing select-none">
                            {#each currentRecommendations as movie, movieIdx (`${getPreferredExternalId(movie.externalIds)?.id || movie.title}-${movie.mediaType || 'movie'}-${movieIdx}`)}
                                <AssistantRecommendationCard
                                    {movie}
                                    {hasRequestPermission}
                                    onplay={handleMoviePlay}
                                    onrequest={handleMovieRequest}
                                    onclick={handleMovieClick} />
                            {/each}
                        </div>
                    {/if}
                </div>
            {/if}

            <!-- Recommended Music -->
            <AssistantMusicRow items={currentMusic} />
        </div>

        <!-- Suggestions sidebar (xl+): vertical grid at full chat height, so the
         conversation keeps its space and more cards are visible at once. -->
        {#if currentRecommendations.length > 0}
            <aside
                class="hidden xl:flex flex-col w-[21.5rem] shrink-0 border-l border-surface-700 bg-surface-800">
                <div class="flex items-center gap-2 p-3 border-b border-surface-700">
                    <Icon src={Sparkles} class="w-4 h-4 text-primary-500" />
                    <h3 class="text-xs font-semibold text-primary-400">
                        {m.assistant_recommended_content({ count: currentRecommendations.length })}
                    </h3>
                </div>
                <div
                    bind:this={sidebarScrollContainer}
                    class="grid grid-cols-2 auto-rows-max gap-2 p-3 overflow-y-auto content-start flex-1">
                    {#each currentRecommendations as movie, movieIdx (`sb-${getPreferredExternalId(movie.externalIds)?.id || movie.title}-${movie.mediaType || 'movie'}-${movieIdx}`)}
                        <AssistantRecommendationCard
                            variant="tile"
                            {movie}
                            {hasRequestPermission}
                            onplay={handleMoviePlay}
                            onrequest={handleMovieRequest}
                            onclick={handleMovieClick} />
                    {/each}
                </div>
            </aside>
        {/if}
    </div>

    <!-- Input Area -->
    <div class="chat-input bg-surface-800 border-t border-surface-700 p-4">
        <form onsubmit={preventDefault(sendMessage)} class="flex gap-2">
            <textarea
                bind:this={textareaElement}
                bind:value={inputMessage}
                onkeydown={handleKeyPress}
                placeholder={rateLimit && rateLimit.remaining === 0
                    ? m.assistant_daily_limit_reached()
                    : m.assistant_placeholder()}
                aria-label={m.assistant_placeholder()}
                maxlength={MAX_MESSAGE_LENGTH}
                disabled={isLoading || (rateLimit && rateLimit.remaining === 0)}
                rows="1"
                class="flex-1 bg-surface-700 border border-surface-600 rounded-xl px-4 py-3 resize-none focus:outline-hidden focus:ring-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                style="min-height: 52px; max-height: 150px;"></textarea>
            <div class="flex flex-col items-end justify-end gap-1">
                {#if inputMessage.length > CHAR_COUNTER_THRESHOLD}
                    <span
                        class="text-xs tabular-nums {inputMessage.length >= MAX_MESSAGE_LENGTH
                            ? 'text-error-400'
                            : 'text-surface-400'}">
                        {inputMessage.length}/{MAX_MESSAGE_LENGTH}
                    </span>
                {/if}
                {#if isStreaming}
                    <!-- While streaming, the Send button becomes a Stop button that
                         aborts the in-flight request (keeps whatever streamed). -->
                    <button
                        type="button"
                        onclick={stopStreaming}
                        class="btn variant-filled-error px-6 rounded-xl flex items-center gap-2"
                        aria-label={m.assistant_stop_aria()}>
                        <Icon src={Stop} class="w-5 h-5" aria-hidden="true" />
                        <span class="hidden sm:inline">{m.assistant_stop()}</span>
                    </button>
                {:else}
                    <button
                        type="submit"
                        disabled={!inputMessage.trim() ||
                            isLoading ||
                            (rateLimit && rateLimit.remaining === 0)}
                        class="btn variant-filled-primary px-6 rounded-xl flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label={isLoading ? m.assistant_sending() : m.assistant_send_aria()}>
                        {#if isLoading}
                            <span
                                class="loading-spinner loading-spinner-white w-5 h-5"
                                aria-hidden="true"></span>
                        {:else}
                            <Icon src={PaperAirplane} class="w-5 h-5" aria-hidden="true" />
                            <span class="hidden sm:inline">{m.assistant_send()}</span>
                        {/if}
                    </button>
                {/if}
            </div>
        </form>
        <div class="mt-2 text-xs text-surface-400 text-center">
            {m.assistant_press_enter_to_send()}
            {#if rateLimit && !rateLimit.isAdmin}
                • {rateLimit.remaining === 0
                    ? m.assistant_daily_budget_reached()
                    : m.assistant_tokens_left({ remaining: formatTokens(rateLimit.remaining) })}
            {/if}
        </div>
    </div>
</div>

<style>
    .chat-container {
        max-height: calc(100vh - 120px);
        background: var(--color-surface-900);
        display: flex;
        flex-direction: column;
    }

    .chat-messages {
        background: linear-gradient(to bottom, var(--color-surface-900), var(--color-surface-800));
        flex: 1;
        min-height: 0;
    }

    .chat-messages::-webkit-scrollbar {
        width: 8px;
    }

    .chat-messages::-webkit-scrollbar-track {
        background: transparent;
    }

    .chat-messages::-webkit-scrollbar-thumb {
        background: rgb(var(--color-surface-500-rgb) / 0.3);
        border-radius: 4px;
    }

    .chat-messages::-webkit-scrollbar-thumb:hover {
        background: rgb(var(--color-surface-500-rgb) / 0.5);
    }

    textarea {
        field-sizing: content;
    }

    .recommended-movies-section {
        flex-shrink: 0;
    }

    .recommended-movies-section .overflow-x-auto {
        scrollbar-width: thin;
        scrollbar-color: rgb(var(--color-surface-500-rgb) / 0.3) transparent;
    }

    .recommended-movies-section .overflow-x-auto::-webkit-scrollbar {
        height: 6px;
    }

    .recommended-movies-section .overflow-x-auto::-webkit-scrollbar-track {
        background: transparent;
    }

    .recommended-movies-section .overflow-x-auto::-webkit-scrollbar-thumb {
        background: rgb(var(--color-surface-500-rgb) / 0.3);
        border-radius: 3px;
    }

    .recommended-movies-section .overflow-x-auto::-webkit-scrollbar-thumb:hover {
        background: rgb(var(--color-surface-500-rgb) / 0.5);
    }

    .chat-input {
        flex-shrink: 0;
    }

    .chat-header {
        flex-shrink: 0;
    }
</style>
