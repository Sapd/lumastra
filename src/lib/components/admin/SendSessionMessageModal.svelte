<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ChatBubbleOvalLeft } from 'svelte-hero-icons';
    import { Z } from '$lib/utils/z-index';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { trapFocus } from '$lib/utils/focus-trap';

    interface Props {
        open: boolean;
        sessionLabel: string;
        /** Longest message the target accepts (a device `ui.message` takes 280). */
        maxChars?: number;
        /** The duration only applies to toast-style delivery; device messages have none. */
        showDuration?: boolean;
        onClose: () => void;
        onSend: (body: {
            message: string;
            severity: 'info' | 'warning' | 'error';
            durationMs: number;
        }) => Promise<void>;
    }

    let {
        open,
        sessionLabel,
        maxChars = 500,
        showDuration = true,
        onClose,
        onSend,
    }: Props = $props();

    const MAX_CHARS = $derived(maxChars);
    const AMBER_THRESHOLD = $derived(Math.floor(maxChars * 0.8));

    let message = $state('');
    let severity = $state<'info' | 'warning' | 'error'>('info');
    let durationSeconds = $state(8);
    let busy = $state(false);

    let charCount = $derived(message.length);
    let charCountColor = $derived(
        charCount >= MAX_CHARS
            ? 'text-red-400'
            : charCount >= AMBER_THRESHOLD
              ? 'text-amber-400'
              : 'text-surface-500',
    );
    let canSend = $derived(message.trim().length > 0 && !busy);

    // Reset form state when modal opens
    let _openTracker = $derived(open);
    $effect(() => {
        if (_openTracker) {
            message = '';
            severity = 'info';
            durationSeconds = 8;
            busy = false;
        }
    });

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape' && !busy) {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            onClose();
        }
    }

    async function handleSend(): Promise<void> {
        if (!canSend) return;
        busy = true;
        try {
            await onSend({
                message: message.trim(),
                severity,
                durationMs: durationSeconds * 1000,
            });
        } finally {
            busy = false;
        }
    }

    const severities: {
        value: 'info' | 'warning' | 'error';
        label: string;
        classes: string;
    }[] = [
        {
            value: 'info',
            label: 'Info',
            classes:
                'border-blue-700/60 bg-blue-900/30 text-blue-300 data-[active]:border-blue-500 data-[active]:bg-blue-900/60',
        },
        {
            value: 'warning',
            label: 'Warning',
            classes:
                'border-amber-700/60 bg-amber-900/20 text-amber-300 data-[active]:border-amber-500 data-[active]:bg-amber-900/50',
        },
        {
            value: 'error',
            label: 'Error',
            classes:
                'border-red-700/60 bg-red-900/20 text-red-300 data-[active]:border-red-500 data-[active]:bg-red-900/50',
        },
    ];
</script>

{#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
        class="modal-overlay modal-overlay-50"
        style="z-index: {Z.MODAL}"
        role="dialog"
        aria-modal="true"
        aria-label="Send message to session"
        tabindex="-1"
        onclick={() => (busy ? undefined : onClose())}
        onkeydown={handleKeydown}>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
            class="card-bordered p-6 max-w-md w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto overscroll-contain"
            role="document"
            use:trapFocus
            onclick={stopPropagation()}>
            <div class="flex items-center gap-2 mb-4">
                <Icon src={ChatBubbleOvalLeft} class="w-5 h-5 text-blue-400 shrink-0" />
                <h3 class="text-xl font-semibold text-white">Send Message</h3>
            </div>

            <p class="text-sm text-surface-400 mb-4">
                To: <span class="text-surface-200 font-medium">{sessionLabel}</span>
            </p>

            <div class="space-y-4 mb-6">
                <!-- Message textarea -->
                <div>
                    <div class="flex items-center justify-between mb-1.5">
                        <label
                            for="session-msg-textarea"
                            class="text-sm font-medium text-surface-300">
                            Message
                        </label>
                        <span class="text-xs {charCountColor}">{charCount} / {MAX_CHARS}</span>
                    </div>
                    <textarea
                        id="session-msg-textarea"
                        bind:value={message}
                        maxlength={MAX_CHARS}
                        rows={3}
                        placeholder="Enter message…"
                        data-autofocus
                        class="w-full rounded-lg bg-surface-800 border border-surface-600 text-white placeholder-surface-500 text-sm px-3 py-2 focus:outline-none focus:border-blue-500 resize-none transition-colors">
                    </textarea>
                </div>

                <!-- Severity pills -->
                <div>
                    <p class="text-sm font-medium text-surface-300 mb-2">Severity</p>
                    <div class="flex gap-2">
                        {#each severities as sev (sev.value)}
                            <button
                                type="button"
                                data-active={severity === sev.value ? '' : undefined}
                                onclick={() => (severity = sev.value)}
                                class="flex-1 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors {sev.classes}">
                                {sev.label}
                            </button>
                        {/each}
                    </div>
                </div>

                <!-- Duration -->
                {#if showDuration}
                    <div>
                        <label
                            for="session-msg-duration"
                            class="text-sm font-medium text-surface-300 mb-1.5 block">
                            Duration
                        </label>
                        <div class="flex items-center gap-2">
                            <input
                                id="session-msg-duration"
                                type="number"
                                bind:value={durationSeconds}
                                min={1}
                                max={60}
                                class="w-20 rounded-lg bg-surface-800 border border-surface-600 text-white text-sm px-3 py-2 focus:outline-none focus:border-blue-500 transition-colors" />
                            <span class="text-sm text-surface-400">seconds</span>
                        </div>
                    </div>
                {/if}
            </div>

            <div class="flex gap-3">
                <button class="btn btn-gray flex-1" disabled={busy} onclick={() => onClose()}>
                    Cancel
                </button>
                <button
                    class="btn btn-blue flex-1 font-medium"
                    onclick={() => void handleSend()}
                    disabled={!canSend}>
                    {busy ? 'Sending…' : 'Send'}
                </button>
            </div>
        </div>
    </div>
{/if}
