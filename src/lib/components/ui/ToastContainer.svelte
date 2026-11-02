<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Z } from '$lib/utils/z-index';
    import { toasts } from '$lib/stores/toast.store';
    import {
        Icon,
        CheckCircle,
        XCircle,
        ExclamationTriangle,
        Sparkles,
        type IconSource,
    } from 'svelte-hero-icons';
    import { fly } from 'svelte/transition';

    type ToastType = 'success' | 'error' | 'warning' | 'info';

    interface Props {
        /**
         * Which fixed corner the stack renders in. Admin IA redesign, spec
         * §6: "toasts stack in a corner that never overlaps panel headers or
         * tab strips" — the admin shell's right slide-in DetailPanel (and its
         * sticky header) lives at the top/right, so the admin layout mounts
         * this with `corner="bottom-left"`; every other surface keeps the
         * original bottom-right placement.
         */
        corner?: 'bottom-right' | 'bottom-left';
    }

    let { corner = 'bottom-right' }: Props = $props();

    interface ToastStyle {
        bgClass: string;
        icon: IconSource;
        iconColor: string;
        textColor: string;
        progressColor: string;
    }

    function getToastStyle(type: string): ToastStyle {
        switch (type as ToastType) {
            case 'success':
                return {
                    bgClass: 'toast-success',
                    icon: CheckCircle,
                    iconColor: 'text-green-400',
                    textColor: 'text-green-100',
                    progressColor: 'bg-green-400',
                };
            case 'error':
                return {
                    bgClass: 'toast-error',
                    icon: XCircle,
                    iconColor: 'text-red-400',
                    textColor: 'text-red-100',
                    progressColor: 'bg-red-400',
                };
            case 'warning':
                return {
                    bgClass: 'toast-warning',
                    icon: ExclamationTriangle,
                    iconColor: 'text-yellow-400',
                    textColor: 'text-yellow-100',
                    progressColor: 'bg-yellow-400',
                };
            default:
                return {
                    bgClass: 'toast-info',
                    icon: Sparkles,
                    iconColor: 'text-blue-400',
                    textColor: 'text-white',
                    progressColor: 'bg-primary-400',
                };
        }
    }
</script>

{#if $toasts.length > 0}
    <!--
        The stack container is `pointer-events-none` — its own box (which can
        be taller/wider than the toasts actually visible, e.g. right after one
        transitions out) must never swallow clicks on whatever admin content
        sits underneath it (spec §6: "never block interaction"). Each toast
        card opts back into `pointer-events-auto` individually so its own
        buttons stay clickable.
    -->
    <div
        class="pointer-events-none fixed space-y-2 max-w-md {corner === 'bottom-left'
            ? 'bottom-4 left-4'
            : 'bottom-4 right-4'}"
        style="z-index: {Z.TOAST}">
        {#each $toasts as toast (toast.id)}
            {@const s = getToastStyle(toast.type)}
            <div
                in:fly={{ y: 100, duration: 300, opacity: 0 }}
                out:fly={{ y: 20, duration: 200, opacity: 0 }}
                role={toast.ariaLive ? 'status' : undefined}
                aria-live={toast.ariaLive}
                class="app-toast w-full shadow-2xl rounded-lg pointer-events-auto ring-1 ring-black/10 overflow-hidden min-w-80 backdrop-blur-sm {s.bgClass}">
                <div class="p-4">
                    <div class="flex items-start">
                        <div class="shrink-0">
                            <Icon src={s.icon} class="h-6 w-6 {s.iconColor}" />
                        </div>
                        <div class="ml-3 w-0 flex-1">
                            <p class="text-sm font-medium break-words {s.textColor}">
                                {toast.message}
                            </p>
                        </div>
                        <!--
                            Optional inline action (e.g. "Undo" after a dismiss).
                            Clicking dispatches the caller's onClick and immediately
                            removes the toast — the action disappears on use so
                            repeated clicks can't fire it twice.
                        -->
                        {#if toast.action}
                            <div class="ml-3 shrink-0 flex">
                                <button
                                    type="button"
                                    class="text-sm font-semibold underline underline-offset-2 text-white/90 hover:text-white"
                                    onclick={() => {
                                        toast.action?.onClick();
                                        toasts.remove(toast.id);
                                    }}>
                                    {toast.action.label}
                                </button>
                            </div>
                        {/if}
                        <div class="ml-4 shrink-0 flex">
                            <button
                                class="rounded-md inline-flex text-white/60 hover:text-white focus:outline-hidden"
                                onclick={() => toasts.remove(toast.id)}>
                                <span class="sr-only">Close</span>
                                <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                    <path
                                        fill-rule="evenodd"
                                        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                                        clip-rule="evenodd"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Progress bar for timed toasts -->
                {#if toast.timeout && toast.timeout > 0}
                    <div class="h-1 w-full bg-black/20">
                        <div
                            class="h-full transition-all linear {s.progressColor}"
                            style="width: 100%; animation: app-toast-shrink {toast.timeout}ms linear forwards;">
                        </div>
                    </div>
                {/if}
            </div>
        {/each}
    </div>
{/if}
