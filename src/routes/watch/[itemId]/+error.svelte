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

    let appName = $derived($page.data?.branding?.appName || 'Dashboard');

    // Surface a server-provided reason (e.g. "not in your library — nothing to
    // play") instead of the generic subtitle, when the load threw a specific
    // message. SvelteKit's generic fallbacks ("Not Found"/"Internal Error") and
    // the bare "Item not found" are not useful to show, so fall back to the
    // themed subtitle for those.
    let specificReason = $derived.by((): string | undefined => {
        const msg = $page.error?.message?.trim();
        if (!msg) return undefined;
        const generic = new Set([
            'Not Found',
            'Internal Error',
            'Item not found',
            'Item not found or not playable',
        ]);
        return generic.has(msg) ? undefined : msg;
    });

    // Same purpose as on the root error page: the only handle a user has on the
    // log line `handleError` wrote. This page suppresses generic messages
    // entirely (above), so on those failures the id is the ONLY diagnostic left.
    let errorId = $derived($page.error?.errorId);

    // Randomized sci-fi flavor quotes for 404 - text comes from translations
    let quotes = $derived([
        { text: m.error_404_quote_1(), author: 'Science Officer' },
        { text: m.error_404_quote_2(), author: 'Operations' },
        { text: m.error_404_quote_3(), author: 'Chief Engineer' },
        { text: m.error_404_quote_4(), author: 'The Captain' },
        { text: m.error_404_quote_5(), author: 'Helm' },
        { text: m.error_404_quote_6(), author: 'Science Officer' },
        { text: m.error_404_quote_7(), author: 'Communications' },
        { text: m.error_404_quote_8(), author: 'Medical Officer' },
    ]);

    const randomIndex = Math.floor(Math.random() * 8);
    let randomQuote = $derived(quotes[randomIndex]);

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
        goto(resolve('/'));
    }

    function goBrowse() {
        goto(resolve('/browse'));
    }
</script>

<svelte:head>
    <title>{m.error_404_title()} | {appName}</title>
</svelte:head>

<div class="error-container">
    <!-- Animated stars background -->
    <div class="stars-container">
        {#each stars as star, i (i)}
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
    <div class="warp-lines"></div>

    <!-- Content -->
    <div class="content">
        <!-- LCARS-style header -->
        <div class="lcars-header">
            <div class="lcars-bar lcars-bar-1"></div>
            <div class="lcars-bar lcars-bar-2"></div>
            <div class="lcars-curve"></div>
        </div>

        <!-- Error code -->
        <div class="error-code">
            <span class="status-text">{m.error_404_alert()}</span>
            <span class="code">{$page.status}</span>
        </div>

        <!-- Main message -->
        <h1 class="title">{m.error_404_title()}</h1>
        <p class="subtitle">{specificReason ?? m.error_404_subtitle()}</p>

        <!-- Quote box -->
        <div class="quote-box">
            <p class="quote">"{randomQuote.text}"</p>
            <p class="author">— {randomQuote.author}</p>
        </div>

        <!-- Technical details -->
        <div class="technical">
            <div class="tech-line">
                <span class="tech-label">{m.error_404_sector()}</span>
                <span class="tech-value">/watch/{$page.params.itemId?.substring(0, 8)}...</span>
            </div>
            <div class="tech-line">
                <span class="tech-label">{m.error_404_status()}</span>
                <span class="tech-value error">{m.error_404_signal_lost()}</span>
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
            <button class="btn-primary" onclick={goBrowse}>
                <svg
                    class="icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2">
                    <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                {m.error_404_browse_library()}
            </button>
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
                {m.error_404_return_to_bridge()}
            </button>
        </div>

        <!-- LCARS-style footer -->
        <div class="lcars-footer">
            <div class="lcars-bar lcars-bar-3"></div>
            <div class="lcars-bar lcars-bar-4"></div>
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

    .code {
        font-size: 5rem;
        font-weight: 700;
        color: #7c3aed;
        line-height: 1;
        text-shadow: 0 0 40px rgba(124, 58, 237, 0.5);
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
    }

    /* Meant to be copied into a bug report: selectable, unbroken, never blinking. */
    .tech-value.reference {
        color: #e6edf7;
        user-select: all;
        letter-spacing: 0.02em;
        word-break: break-all;
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
    }
</style>
