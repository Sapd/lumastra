<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * AssistantOpener — a greeting and one suggestion, above the thread.
     *
     * Shown whether the conversation is empty or restored, which is the whole
     * point: the static welcome screen only ever appeared on an empty thread,
     * so resuming a conversation greeted you with nothing.
     *
     * It is NEVER written into chat history. A real assistant message would be
     * persisted and then fed back to the model on the next turn as if the
     * assistant had said it — so this stays a piece of UI.
     *
     * The greeting is decided by the USER's clock, not the server's, and the
     * suggestion arrives as structured data so the wording is localised here,
     * where the message catalogue is.
     */
    import { onMount } from 'svelte';
    import { Icon, XMark, Sparkles } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    const HOOK_KINDS = ['resume_audiobook', 'new_arrival', 'watchlist', 'top_rated'] as const;
    type HookKind = (typeof HOOK_KINDS)[number];

    interface OpenerHook {
        kind: HookKind;
        title: string;
        remainingMinutes?: number;
    }

    /**
     * The switches below have no default — exhaustive over HookKind, which the
     * compiler checks. That guarantee stops at the network boundary: this comes
     * from fetch(), so a server that grows a fifth kind before this deploys
     * would fall out of both switches as `undefined` and render the literal
     * string "undefined" as the suggestion. Validate before trusting it.
     */
    function asHook(value: unknown): OpenerHook | null {
        if (!value || typeof value !== 'object') return null;
        const candidate = value as Partial<OpenerHook>;
        if (!HOOK_KINDS.includes(candidate.kind as HookKind)) return null;
        if (typeof candidate.title !== 'string' || candidate.title === '') return null;
        return candidate as OpenerHook;
    }

    interface Props {
        /** Display name for the greeting. */
        name: string;
        /**
         * Identifies WHOSE dismissal is stored. localStorage is per browser, not
         * per account, so without this a shared machine let one person's dismissal
         * hide the opener from everyone else who signed in that day.
         */
        dismissalScope?: string;
        /** Called with the question to drop into the input box. */
        onsuggestionSelected?: (prompt: string) => void;
    }

    let { name, dismissalScope = 'anon', onsuggestionSelected }: Props = $props();

    let hook = $state<OpenerHook | null>(null);
    let dismissed = $state(false);

    /** One dismissal covers the rest of the calendar day, per browser AND account. */
    const todayKey = (): string =>
        `assistant-opener-dismissed:${dismissalScope}:${new Date().toDateString()}`;

    /**
     * "25h 50m" / "42 min". An audiobook can have a thousand minutes left, and
     * "dir fehlen noch 1551 Minuten" is not something a person says.
     */
    function humanDuration(totalMinutes: number): string {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`;
    }

    /**
     * Rendered from state rather than called in the template, so the value the
     * BROWSER computes is what ends up on screen. Called inline it also ran
     * during SSR, stamping the server's hour into the HTML — and a non-reactive
     * template expression is not guaranteed to be re-evaluated into the DOM at
     * hydration, so a server in another timezone could leave "good evening" on a
     * user's morning. onMount re-runs it once the browser is definitely the one
     * asking.
     */
    let greetingText = $state(greeting());

    function greeting(): string {
        const h = new Date().getHours();
        if (h < 11) return m.assistant_opener_greeting_morning({ name });
        if (h < 17) return m.assistant_opener_greeting_afternoon({ name });
        if (h < 23) return m.assistant_opener_greeting_evening({ name });
        return m.assistant_opener_greeting_night({ name });
    }

    function suggestionText(h: OpenerHook): string {
        switch (h.kind) {
            case 'resume_audiobook':
                return h.remainingMinutes === undefined
                    ? m.assistant_opener_resume_audiobook_no_time({ title: h.title })
                    : m.assistant_opener_resume_audiobook({
                          title: h.title,
                          remaining: humanDuration(h.remainingMinutes),
                      });
            case 'new_arrival':
                return m.assistant_opener_new_arrival({ title: h.title });
            case 'watchlist':
                return m.assistant_opener_watchlist({ title: h.title });
            case 'top_rated':
                return m.assistant_opener_top_rated({ title: h.title });
        }
    }

    function promptText(h: OpenerHook): string {
        switch (h.kind) {
            case 'resume_audiobook':
                return m.assistant_opener_prompt_resume_audiobook({ title: h.title });
            case 'new_arrival':
                return m.assistant_opener_prompt_new_arrival({ title: h.title });
            case 'watchlist':
                return m.assistant_opener_prompt_watchlist({ title: h.title });
            case 'top_rated':
                return m.assistant_opener_prompt_top_rated({ title: h.title });
        }
    }

    function dismiss(): void {
        dismissed = true;
        try {
            localStorage.setItem(todayKey(), '1');
        } catch {
            // Private mode / storage disabled — dismissing for this view is enough.
        }
    }

    onMount(() => {
        greetingText = greeting();

        // `hidden md:flex` keeps this out of the layout below Tailwind's md
        // breakpoint, so on a phone the request below buys a section that is
        // never rendered. Same 768px the class uses.
        if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) {
            return;
        }

        try {
            if (localStorage.getItem(todayKey())) {
                dismissed = true;
                return;
            }
        } catch {
            // Unreadable storage is not a reason to skip the greeting.
        }

        // Best-effort: this decorates a page the user opened to do something
        // else, so a failure costs the greeting and nothing more.
        void fetch('/api/assistant/opener')
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                hook = asHook(data?.hook);
            })
            .catch(() => {
                hook = null;
            });
    });
</script>

{#if !dismissed}
    <!-- Desktop only: above a phone-sized thread this costs more vertical space
         than the suggestion is worth. `hidden md:flex` keeps it out of the
         layout entirely rather than merely invisible. -->
    <div
        class="hidden md:flex items-center gap-3 px-4 py-2.5 border-b border-surface-500/20 bg-surface-500/5">
        <Icon src={Sparkles} class="w-4 h-4 text-primary-500 shrink-0" />
        <p class="text-sm text-surface-300 min-w-0 flex-1">
            <span class="font-medium">{greetingText}</span>{#if hook}{@const h = hook}<span>
                    —
                </span><button
                    type="button"
                    class="text-primary-400 hover:text-primary-300 underline underline-offset-2 text-left"
                    onclick={() => onsuggestionSelected?.(promptText(h))}>
                    {suggestionText(h)}
                </button>{/if}
        </p>
        <button
            type="button"
            class="btn-icon btn-icon-sm variant-ghost-surface shrink-0"
            aria-label={m.assistant_opener_dismiss()}
            title={m.assistant_opener_dismiss()}
            onclick={dismiss}>
            <Icon src={XMark} class="w-4 h-4" />
        </button>
    </div>
{/if}
