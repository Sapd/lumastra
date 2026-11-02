<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { page } from '$app/stores';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { onMount } from 'svelte';

    let appName = $derived($page.data?.branding?.appName || (m.nav_dashboard() as string));
    let status = $derived($page.status);
    let errorMessage = $derived($page.error?.message || m.error_page_unknown());

    // Determine error type for styling and content
    let isNotFound = $derived(status === 404);
    let isServerError = $derived(status >= 500);

    // Mask server-internal detail on 5xx. A route `load` may throw
    // `error(503, 'Database connection unavailable')` (or similar), and
    // SvelteKit preserves the message of an explicitly-thrown error verbatim —
    // surfacing the backing store / internal failure to any visitor. 4xx
    // messages are intentional and client-safe (e.g. "Content not available"),
    // so those are shown as-is.
    let displayedError = $derived(isServerError ? m.error_page_unknown() : errorMessage);

    // The one thing that ties this page to the log line `handleError` wrote.
    // Masking the 5xx message above is what makes it necessary: the visitor is
    // deliberately told nothing about the failure, so without the id a report
    // cannot be matched to anything.
    let errorId = $derived($page.error?.errorId);

    // Quote authors for different error types
    const authors404 = [
        'Science Officer',
        'Operations',
        'Chief Engineer',
        'The Captain',
        'Helm',
        'Science Officer',
        'Communications',
        'Medical Officer',
    ];
    const authors500 = [
        'Chief Engineer',
        'Operations',
        'Tactical',
        'Engineering',
        'Chief Engineer',
        "Ship's Computer",
        'Operations',
        'Medical Officer',
    ];

    // Select quotes based on error type
    let quotes404 = $derived([
        { text: m.error_404_quote_1(), author: authors404[0] },
        { text: m.error_404_quote_2(), author: authors404[1] },
        { text: m.error_404_quote_3(), author: authors404[2] },
        { text: m.error_404_quote_4(), author: authors404[3] },
        { text: m.error_404_quote_5(), author: authors404[4] },
        { text: m.error_404_quote_6(), author: authors404[5] },
        { text: m.error_404_quote_7(), author: authors404[6] },
        { text: m.error_404_quote_8(), author: authors404[7] },
    ]);

    let quotes500 = $derived([
        { text: m.error_500_quote_1(), author: authors500[0] },
        { text: m.error_500_quote_2(), author: authors500[1] },
        { text: m.error_500_quote_3(), author: authors500[2] },
        { text: m.error_500_quote_4(), author: authors500[3] },
        { text: m.error_500_quote_5(), author: authors500[4] },
        { text: m.error_500_quote_6(), author: authors500[5] },
        { text: m.error_500_quote_7(), author: authors500[6] },
        { text: m.error_500_quote_8(), author: authors500[7] },
    ]);

    const randomIndex = Math.floor(Math.random() * 8);
    let randomQuote = $derived(isServerError ? quotes500[randomIndex] : quotes404[randomIndex]);

    // Get localized strings based on error type
    let alertText = $derived(
        isServerError
            ? m.error_500_alert()
            : isNotFound
              ? m.error_404_alert()
              : m.error_general_alert(),
    );
    let titleText = $derived(
        isServerError
            ? m.error_500_title()
            : isNotFound
              ? m.error_404_title()
              : m.error_general_title(),
    );
    let subtitleText = $derived(
        isServerError
            ? m.error_500_subtitle()
            : isNotFound
              ? m.error_404_subtitle()
              : m.error_general_subtitle(),
    );

    // Stars animation
    let stars: {
        x: number;
        y: number;
        size: number;
        speed: number;
        opacity: number;
    }[] = $state([]);

    onMount(() => {
        // Generate random stars
        for (let i = 0; i < 100; i++) {
            stars.push({
                x: Math.random() * 100,
                y: Math.random() * 100,
                size: Math.random() * 2 + 1,
                speed: Math.random() * 2 + 0.5,
                opacity: Math.random() * 0.5 + 0.5,
            });
        }
        stars = stars;
    });

    function goHome() {
        void goto(resolve('/'));
    }

    function tryAgain() {
        window.location.reload();
    }
</script>

<svelte:head>
    <title>{titleText} | {appName}</title>
</svelte:head>

<div class="error-container" class:server-error={isServerError}>
    <!-- Animated stars background -->
    <div class="stars-container">
        {#each stars as star, index (index)}
            <div
                class="star"
                style="
                    left: {star.x}%;
                    top: {star.y}%;
                    width: {star.size}px;
                    height: {star.size}px;
                    opacity: {star.opacity};
                    animation-duration: {star.speed}s;
                ">
            </div>
        {/each}
    </div>

    <!-- Warp effect lines -->
    <div class="warp-lines" class:red-alert={isServerError}></div>

    <!-- Content -->
    <div class="content">
        <!-- LCARS-style header -->
        <div class="lcars-header">
            <div class="lcars-bar lcars-bar-1" class:red={isServerError}></div>
            <div class="lcars-bar lcars-bar-2" class:red={isServerError}></div>
            <div class="lcars-curve"></div>
        </div>

        <!-- Error code -->
        <div class="error-code">
            <span class="status-text" class:red-text={isServerError}>{alertText}</span>
            <span class="code" class:red-code={isServerError}>{status}</span>
        </div>

        <!-- Main message -->
        <h1 class="title">{titleText}</h1>
        <p class="subtitle">{subtitleText}</p>

        <!-- Quote box -->
        <div class="quote-box" class:red-border={isServerError}>
            <p class="quote">"{randomQuote.text}"</p>
            <p class="author">— {randomQuote.author}</p>
        </div>

        <!-- Technical details -->
        <div class="technical">
            <div class="tech-line">
                <span class="tech-label">{m.error_page_path()}</span>
                <span class="tech-value">{$page.url.pathname}</span>
            </div>
            <div class="tech-line">
                <span class="tech-label">{m.error_404_status()}</span>
                <span class="tech-value error" class:red-text={isServerError}
                    >{status} - {displayedError}</span>
            </div>
            {#if errorId}
                <div class="tech-line">
                    <span class="tech-label">{m.error_page_reference()}</span>
                    <span class="tech-value reference">{errorId}</span>
                </div>
            {/if}
            <div class="tech-line">
                <span class="tech-label">{m.error_404_recommendation()}</span>
                <span class="tech-value">{m.error_404_return_suggestion()}</span>
            </div>
        </div>

        {#if errorId}
            <p class="reference-hint">{m.error_page_reference_hint()}</p>
        {/if}

        <!-- Action buttons -->
        <div class="actions">
            {#if isServerError}
                <button class="btn-primary red-btn" onclick={tryAgain}>
                    <svg
                        class="icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2">
                        <path
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {m.error_try_again()}
                </button>
            {/if}
            <button class="btn-secondary" onclick={goHome}>
                <svg
                    class="icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2">
                    <path
                        d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                </svg>
                {m.error_go_home()}
            </button>
        </div>

        <!-- LCARS-style footer -->
        <div class="lcars-footer">
            <div class="lcars-bar lcars-bar-3" class:red={isServerError}></div>
            <div class="lcars-bar lcars-bar-4" class:red={isServerError}></div>
        </div>
    </div>
</div>

<style>
    .error-container {
        min-height: 100vh;
        min-height: 100dvh;
        background: linear-gradient(180deg, #0a0a1a 0%, #1a1a3a 50%, #0a0a1a 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        overflow: hidden;
        padding: 2rem;
    }

    .error-container.server-error {
        background: linear-gradient(180deg, #1a0a0a 0%, #3a1a1a 50%, #1a0a0a 100%);
    }

    /* Stars */
    .stars-container {
        position: absolute;
        inset: 0;
        overflow: hidden;
    }

    .star {
        position: absolute;
        background: white;
        border-radius: 50%;
        animation: twinkle 2s ease-in-out infinite alternate;
    }

    @keyframes twinkle {
        0% {
            opacity: 0.3;
            transform: scale(1);
        }
        100% {
            opacity: 1;
            transform: scale(1.2);
        }
    }

    /* Warp lines effect */
    .warp-lines {
        position: absolute;
        inset: 0;
        background: radial-gradient(
            ellipse at center,
            transparent 0%,
            transparent 50%,
            rgba(124, 58, 237, 0.03) 100%
        );
        animation: warp-pulse 4s ease-in-out infinite;
    }

    .warp-lines.red-alert {
        background: radial-gradient(
            ellipse at center,
            transparent 0%,
            transparent 50%,
            rgba(237, 58, 58, 0.05) 100%
        );
    }

    @keyframes warp-pulse {
        0%,
        100% {
            opacity: 0.5;
        }
        50% {
            opacity: 1;
        }
    }

    /* Content */
    .content {
        position: relative;
        z-index: 10;
        text-align: center;
        max-width: 600px;
        width: 100%;
    }

    /* LCARS-style elements */
    .lcars-header,
    .lcars-footer {
        display: flex;
        gap: 0.5rem;
        justify-content: center;
        margin-bottom: 2rem;
    }

    .lcars-footer {
        margin-top: 2rem;
        margin-bottom: 0;
    }

    .lcars-bar {
        height: 8px;
        border-radius: 4px;
    }

    .lcars-bar-1 {
        width: 60px;
        background: #ff9500;
    }

    .lcars-bar-2 {
        width: 120px;
        background: #cc99ff;
    }

    .lcars-bar-3 {
        width: 100px;
        background: #9999ff;
    }

    .lcars-bar-4 {
        width: 80px;
        background: #ff9500;
    }

    .lcars-bar.red {
        background: #ff4444;
    }

    /* Error code */
    .error-code {
        display: flex;
        flex-direction: column;
        align-items: center;
        margin-bottom: 1.5rem;
    }

    .status-text {
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0.2em;
        color: #ff6b6b;
        text-transform: uppercase;
        margin-bottom: 0.5rem;
    }

    .status-text.red-text {
        color: #ff4444;
        animation: pulse-red 1s ease-in-out infinite;
    }

    @keyframes pulse-red {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.6;
        }
    }

    .code {
        font-size: 5rem;
        font-weight: 700;
        color: #7c3aed;
        line-height: 1;
        text-shadow: 0 0 40px rgba(124, 58, 237, 0.5);
    }

    .code.red-code {
        color: #ff4444;
        text-shadow: 0 0 40px rgba(255, 68, 68, 0.5);
    }

    /* Title */
    .title {
        font-size: 2rem;
        font-weight: 700;
        color: white;
        margin-bottom: 0.5rem;
    }

    .subtitle {
        font-size: 1rem;
        color: #a0a0c0;
        margin-bottom: 2rem;
    }

    /* Quote */
    .quote-box {
        background: rgba(124, 58, 237, 0.1);
        border: 1px solid rgba(124, 58, 237, 0.3);
        border-radius: 12px;
        padding: 1.5rem;
        margin-bottom: 2rem;
    }

    .quote-box.red-border {
        background: rgba(255, 68, 68, 0.1);
        border-color: rgba(255, 68, 68, 0.3);
    }

    .quote {
        font-size: 1.1rem;
        font-style: italic;
        color: #e0e0ff;
        margin-bottom: 0.75rem;
        line-height: 1.5;
    }

    .author {
        font-size: 0.9rem;
        color: #cc99ff;
        font-weight: 500;
    }

    .quote-box.red-border .author {
        color: #ff8888;
    }

    /* Technical details */
    .technical {
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        padding: 1rem;
        margin-bottom: 2rem;
        font-family: 'Courier New', monospace;
        font-size: 0.8rem;
        text-align: left;
    }

    .tech-line {
        display: flex;
        gap: 1rem;
        padding: 0.25rem 0;
    }

    .tech-label {
        color: #ff9500;
        min-width: 120px;
    }

    .tech-value {
        color: #99ccff;
        word-break: break-all;
    }

    /* Meant to be copied into a bug report, so it stays selectable and never
       blinks or truncates the way the status line does. */
    .tech-value.reference {
        color: #e6edf7;
        user-select: all;
        letter-spacing: 0.02em;
    }

    .reference-hint {
        margin: -1.5rem 0 2rem;
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.55);
        text-align: left;
    }

    .tech-value.error {
        color: #ff6b6b;
        animation: blink 1s ease-in-out infinite;
    }

    .tech-value.error.red-text {
        color: #ff4444;
    }

    @keyframes blink {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.5;
        }
    }

    /* Buttons */
    .actions {
        display: flex;
        gap: 1rem;
        justify-content: center;
        flex-wrap: wrap;
    }

    .btn-primary,
    .btn-secondary {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.875rem 1.5rem;
        border-radius: 8px;
        font-weight: 600;
        font-size: 0.9rem;
        cursor: pointer;
        transition: all 0.2s ease;
        border: none;
    }

    .btn-primary {
        background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
        color: white;
        box-shadow: 0 4px 15px rgba(124, 58, 237, 0.4);
    }

    .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(124, 58, 237, 0.5);
    }

    .btn-primary.red-btn {
        background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
        box-shadow: 0 4px 15px rgba(239, 68, 68, 0.4);
    }

    .btn-primary.red-btn:hover {
        box-shadow: 0 6px 20px rgba(239, 68, 68, 0.5);
    }

    .btn-secondary {
        background: rgba(255, 255, 255, 0.1);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .btn-secondary:hover {
        background: rgba(255, 255, 255, 0.15);
        border-color: rgba(255, 255, 255, 0.3);
    }

    .icon {
        width: 1.25rem;
        height: 1.25rem;
    }

    /* Responsive */
    @media (max-width: 480px) {
        .code {
            font-size: 4rem;
        }

        .title {
            font-size: 1.5rem;
        }

        .quote {
            font-size: 1rem;
        }

        .actions {
            flex-direction: column;
        }

        .btn-primary,
        .btn-secondary {
            width: 100%;
            justify-content: center;
        }

        .tech-line {
            flex-direction: column;
            gap: 0.25rem;
        }

        .tech-label {
            min-width: unset;
        }
    }
</style>
