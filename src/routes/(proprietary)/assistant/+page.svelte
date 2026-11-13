<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import AiAssistant from '$lib/proprietary/components/AiAssistant.svelte';
    import { Icon, ArrowLeft } from 'svelte-hero-icons';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';

    // Get initial question from query parameter
    let initialQuestion = $derived($page.url.searchParams.get('q') || '');
    let appName = $derived($page.data?.branding?.appName || 'Dashboard');
    let chatbotName = $derived($page.data?.chatbot?.name || 'Assistant');
</script>

<svelte:head>
    <title>{m.assistant_page_title({ chatbotName, appName })}</title>
</svelte:head>

<div class="container mx-auto px-4 pt-4 lg:pt-20 pb-8 h-full">
    <!-- xl+ widens the shell for the suggestions sidebar; below xl the chat
         keeps its familiar reading width (bottom-rail layout). -->
    <div class="max-w-5xl xl:max-w-7xl mx-auto h-full flex flex-col gap-4">
        <!-- Back Button -->
        <div class="back-button-container shrink-0">
            <a href={resolve('/')} class="btn variant-ghost-surface flex items-center gap-2 w-fit">
                <Icon src={ArrowLeft} class="w-5 h-5" />
                <span>{m.assistant_back_to_dashboard()}</span>
            </a>
        </div>

        <!-- Chat Component -->
        <div class="chat-wrapper flex-1 card variant-soft overflow-hidden">
            <AiAssistant {initialQuestion} />
        </div>
    </div>
</div>

<style>
    .container {
        min-height: calc(100vh - 80px);
    }

    /* Ensure back button stays above chat and is fully clickable */
    .back-button-container {
        position: relative;
        z-index: 50;
        pointer-events: auto;
        min-height: 48px; /* Reserve space for the button */
        margin-top: 15px;
    }

    .back-button-container a {
        pointer-events: auto;
    }

    .chat-wrapper {
        position: relative;
        z-index: 1;
        /* Prevent chat from overlapping button */
        margin-top: 0;
    }
</style>
