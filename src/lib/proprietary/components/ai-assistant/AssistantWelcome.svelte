<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
  Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
-->

<script lang="ts">
    /**
     * ChatWelcome - Welcome screen with suggested questions
     * Shown when no messages exist in the chat
     */
    import { Icon, InformationCircle, ChatBubbleOvalLeft } from 'svelte-hero-icons';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        chatbotName?: string;
        chatbotAvatar?: string;
        onquestionSelected?: (detail: string) => void;
    }

    let { chatbotName = '', chatbotAvatar = '', onquestionSelected }: Props = $props();

    let appName = $derived($page.data?.branding?.appName || 'Dashboard');
    let displayName = $derived(chatbotName || 'Assistant');

    const suggestedQuestions = [
        m.assistant_suggestion_1(),
        m.assistant_suggestion_2(),
        m.assistant_suggestion_3(),
        m.assistant_suggestion_4(),
    ];

    function selectQuestion(question: string) {
        onquestionSelected?.(question);
    }
</script>

<div class="center-col h-full text-center">
    {#if chatbotAvatar}
        <img
            src={chatbotAvatar}
            alt={displayName}
            class="w-24 h-24 rounded-full border-4 border-primary-500 mb-4 object-cover" />
    {:else}
        <div
            class="w-24 h-24 rounded-full bg-primary-500/20 border-4 border-primary-500 mb-4 center">
            <Icon src={ChatBubbleOvalLeft} class="w-12 h-12 text-primary-500" />
        </div>
    {/if}
    <h3 class="text-2xl font-bold mb-2">
        {m.assistant_hi_im({ name: displayName })}
    </h3>
    <p class="text-surface-400 max-w-md mb-6">
        {m.assistant_description({ appName })}
    </p>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-2xl w-full px-4">
        {#each suggestedQuestions as question (question)}
            <button
                class="btn variant-ghost-surface text-left p-4 h-auto min-h-[3rem] whitespace-normal leading-snug"
                onclick={() => selectQuestion(question)}
                aria-label={m.assistant_ask_question({ question })}>
                <Icon
                    src={InformationCircle}
                    class="w-5 h-5 shrink-0 mr-2 self-start mt-0.5"
                    aria-hidden="true" />
                <span class="flex-1">"{question}"</span>
            </button>
        {/each}
    </div>
</div>
