<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { modals } from '$lib/stores/modal.store';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        title?: string;
        body: string;
        confirmText?: string;
        cancelText?: string;
        scrollBody?: boolean;
        reviewLinks?: { href: string; label: string }[];
        confirmVariant?: 'primary' | 'danger';
        onConfirm: () => void | Promise<void>;
        onCancel?: (() => void) | undefined;
    }

    let {
        title = m.dialog_confirm_title(),
        body,
        confirmText = m.dialog_confirm_button(),
        cancelText = m.dialog_cancel_button(),
        confirmVariant = 'primary',
        scrollBody = false,
        reviewLinks = [],
        onConfirm,
        onCancel = undefined,
    }: Props = $props();

    let loading = $state(false);
    let cancelButton: HTMLButtonElement;

    async function handleConfirm() {
        loading = true;
        try {
            await onConfirm();
            await modals.close();
        } catch (error) {
            console.error('Confirm action failed:', error);
            loading = false;
        }
    }

    async function handleCancel() {
        if (onCancel) {
            await onCancel();
        }
        await modals.close();
    }
</script>

<div
    class={['confirm-modal card p-6 w-modal shadow-xl', { 'review-body': scrollBody }]}
    aria-describedby="confirm-modal-desc">
    <header class="modal-header mb-4">
        <h3 class="h3">{title}</h3>
    </header>

    {#if reviewLinks.length > 0}
        <button
            type="button"
            class="btn variant-ghost-surface"
            disabled={loading}
            onclick={() => cancelButton.focus()}>{m.dialog_jump_to_actions()}</button>
    {/if}

    <!-- The review region needs keyboard focus for scrolling. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <article
        class={['modal-body mb-6', { 'scroll-body': scrollBody }]}
        tabindex={scrollBody ? 0 : undefined}>
        <p id="confirm-modal-desc">{body}</p>
        {#each reviewLinks as link (link.href)}
            <p>
                <a
                    class="anchor break-all"
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer">{link.label}</a>
            </p>
        {/each}
    </article>

    <footer class="modal-footer flex justify-end gap-2">
        <button
            type="button"
            class="btn variant-ghost-surface"
            bind:this={cancelButton}
            onclick={handleCancel}
            disabled={loading}>
            {cancelText}
        </button>
        <button
            type="button"
            class="btn {confirmVariant === 'danger'
                ? 'variant-filled-error'
                : 'variant-filled-primary'}"
            onclick={handleConfirm}
            disabled={loading}>
            {#if loading}
                <span class="animate-spin">⏳</span>
            {/if}
            {confirmText}
        </button>
    </footer>
</div>

<style>
    .review-body {
        max-height: calc(100dvh - 2rem);
        display: flex;
        flex-direction: column;
    }

    .scroll-body {
        max-height: 55vh;
        overflow-y: auto;
        overscroll-behavior: contain;
        white-space: pre-line;
        overflow-wrap: anywhere;
        min-height: 0;
    }

    .confirm-modal {
        max-width: 500px;
    }
</style>
