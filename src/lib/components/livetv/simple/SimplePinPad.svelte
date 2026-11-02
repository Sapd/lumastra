<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Big on-screen number pad for the simple-mode lock PIN (also takes the
    // keyboard's digits). `onsubmit` returns an error message or null.
    import * as m from '$lib/paraglide/messages.js';
    import { trapFocus } from '$lib/utils/focus-trap';

    interface Props {
        title: string;
        onsubmit: (pin: string) => Promise<string | null>;
        oncancel: () => void;
    }

    let { title, onsubmit, oncancel }: Props = $props();

    let pin = $state('');
    let error = $state<string | null>(null);
    let busy = $state(false);
    let dialogEl = $state<HTMLDivElement | undefined>();

    const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

    function press(d: string): void {
        if (pin.length < 8) pin += d;
        error = null;
    }

    async function submit(): Promise<void> {
        if (pin.length < 4 || busy) return;
        busy = true;
        try {
            error = await onsubmit(pin);
        } catch {
            error = m.livetv_simple_setup_failed();
        } finally {
            busy = false;
        }
        if (error) pin = '';
    }

    function onKeydown(e: KeyboardEvent): void {
        if (/^[0-9]$/.test(e.key)) {
            e.preventDefault();
            press(e.key);
        } else if (e.key === 'Backspace') {
            e.preventDefault();
            pin = pin.slice(0, -1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            oncancel();
        }
    }

    $effect(() => {
        dialogEl?.focus();
    });
</script>

<div class="backdrop">
    <div
        class="pad"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabindex="-1"
        use:trapFocus
        bind:this={dialogEl}
        onkeydown={onKeydown}>
        <h2>{title}</h2>
        <div class="dots" aria-label={m.livetv_simple_pin_digits({ count: pin.length })}>
            {#each Array.from({ length: Math.max(4, pin.length) }, (_, i) => i) as i (i)}
                <span class:filled={i < pin.length}></span>
            {/each}
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <div class="keys">
            {#each KEYS as k (k)}
                <button type="button" onclick={() => press(k)}>{k}</button>
            {/each}
            <button
                type="button"
                class="aux"
                onclick={() => (pin = pin.slice(0, -1))}
                aria-label={m.livetv_simple_pin_delete()}>⌫</button>
            <button type="button" onclick={() => press('0')}>0</button>
            <button
                type="button"
                class="ok"
                disabled={pin.length < 4 || busy}
                onclick={() => void submit()}>{m.livetv_simple_pin_ok()}</button>
        </div>
        <button type="button" class="cancel" onclick={oncancel}>{m.common_cancel()}</button>
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        background: rgb(0 0 0 / 0.8);
    }
    .pad {
        width: min(100%, 26rem);
        padding: 1.5rem;
        border-radius: 1.5rem;
        background: #111827;
        border: 3px solid #4b5563;
        color: #fff;
        text-align: center;
        outline: none;
    }
    h2 {
        font-size: 1.5rem;
        font-weight: 800;
        margin-bottom: 1rem;
    }
    .dots {
        display: flex;
        justify-content: center;
        gap: 0.75rem;
        margin-bottom: 1rem;
    }
    .dots span {
        width: 1.25rem;
        height: 1.25rem;
        border-radius: 999px;
        border: 3px solid #fde047;
    }
    .dots span.filled {
        background: #fde047;
    }
    .error {
        color: #fca5a5;
        font-size: 1.15rem;
        font-weight: 700;
        margin-bottom: 0.75rem;
    }
    .keys {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.6rem;
    }
    .keys button {
        min-height: 4.5rem;
        border-radius: 1rem;
        background: #1f2937;
        border: 2px solid #4b5563;
        font-size: 2rem;
        font-weight: 800;
    }
    .keys .aux {
        font-size: 1.6rem;
    }
    .keys .ok {
        background: #fde047;
        color: #111827;
        font-size: 1.3rem;
    }
    .keys .ok:disabled {
        opacity: 0.4;
    }
    button:focus-visible {
        outline: 5px solid #fde047;
        outline-offset: 3px;
    }
    .cancel {
        margin-top: 1rem;
        min-height: 3.5rem;
        padding: 0 1.5rem;
        border-radius: 999px;
        border: 2px solid #6b7280;
        font-size: 1.15rem;
        font-weight: 700;
    }
</style>
