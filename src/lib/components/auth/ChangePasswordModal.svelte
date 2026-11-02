<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Change-password modal for native-login (session) users. Verifies the current
  password, applies a new one (with a live strength meter), and the server
  rotates the session. Only ever reached by session users — forward-auth users
  don't see the entry point (Footer gates it on authMethod === 'session').
-->

<script lang="ts">
    import { modals } from '$lib/stores/modal.store';
    import { toasts } from '$lib/stores/toast.store';
    import { Icon, XMark } from 'svelte-hero-icons';
    import { estimatePasswordStrength, PASSWORD_MIN_LENGTH } from '$lib/shared/password-strength';
    import { z } from 'zod';
    import { apiPost } from '$lib/api/client.js';

    let current = $state('');
    let next = $state('');
    let confirm = $state('');
    let submitting = $state(false);
    let error = $state('');

    const strength = $derived(estimatePasswordStrength(next));
    const matches = $derived(next.length > 0 && next === confirm);
    const canSubmit = $derived(current.length > 0 && strength.acceptable && matches && !submitting);

    const meterColor = $derived(
        ['bg-error-500', 'bg-error-500', 'bg-warning-500', 'bg-lime-500', 'bg-success-500'][
            strength.score
        ],
    );

    async function close(): Promise<void> {
        await modals.close();
    }

    async function submit(event: Event): Promise<void> {
        event.preventDefault();
        if (!canSubmit) return;
        submitting = true;
        error = '';
        try {
            const { error: apiError } = await apiPost(
                '/api/auth/native/change-password',
                z.object({}).passthrough(),
                { currentPassword: current, newPassword: next },
            );
            if (apiError) {
                error = apiError;
                return;
            }
            toasts.success('Password changed. Other sessions were signed out.');
            await modals.close();
        } finally {
            submitting = false;
        }
    }
</script>

<div class="change-password-modal card p-6 shadow-xl">
    <header class="relative mb-5">
        <button
            type="button"
            class="absolute right-0 top-0 text-surface-400 hover:text-white"
            aria-label="Close"
            onclick={close}>
            <Icon src={XMark} class="h-6 w-6" />
        </button>
        <h2 class="h3">Change password</h2>
        <p class="text-sm text-surface-400">
            Choose a strong new password. You'll stay signed in here; any other devices will be
            signed out.
        </p>
    </header>

    <form method="post" class="space-y-4" onsubmit={submit}>
        <label class="block">
            <span class="text-sm text-surface-300">Current password</span>
            <input
                class="input mt-1 w-full"
                type="password"
                autocomplete="current-password"
                bind:value={current}
                required />
        </label>

        <label class="block">
            <span class="text-sm text-surface-300">New password</span>
            <input
                class="input mt-1 w-full"
                type="password"
                autocomplete="new-password"
                bind:value={next}
                required />
            {#if next.length > 0}
                <div class="mt-2">
                    <div class="flex gap-1" aria-hidden="true">
                        {#each [0, 1, 2, 3] as seg (seg)}
                            <div
                                class="h-1.5 flex-1 rounded-full {strength.score > seg
                                    ? meterColor
                                    : 'bg-surface-600'}">
                            </div>
                        {/each}
                    </div>
                    <p class="mt-1 text-xs text-surface-400">
                        Strength: <span class="capitalize">{strength.label}</span
                        >{#if strength.warnings.length}
                            — {strength.warnings[0]}{/if}
                    </p>
                </div>
            {:else}
                <p class="mt-1 text-xs text-surface-500">
                    At least {PASSWORD_MIN_LENGTH} characters; mix letters, numbers and symbols.
                </p>
            {/if}
        </label>

        <label class="block">
            <span class="text-sm text-surface-300">Confirm new password</span>
            <input
                class="input mt-1 w-full"
                type="password"
                autocomplete="new-password"
                bind:value={confirm}
                required />
            {#if confirm.length > 0 && !matches}
                <p class="mt-1 text-xs text-error-400">Passwords don't match.</p>
            {/if}
        </label>

        {#if error}
            <p class="text-sm text-error-400" role="alert">{error}</p>
        {/if}

        <div class="flex justify-end gap-2 pt-1">
            <button type="button" class="btn variant-ghost-surface" onclick={close}>Cancel</button>
            <button type="submit" class="btn variant-filled-primary" disabled={!canSubmit}>
                {submitting ? 'Saving…' : 'Change password'}
            </button>
        </div>
    </form>
</div>

<style>
    .change-password-modal {
        width: min(28rem, 92vw);
    }
</style>
