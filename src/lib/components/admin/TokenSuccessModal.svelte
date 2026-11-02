<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, Key, ClipboardDocument, Check, ExclamationTriangle } from 'svelte-hero-icons';
    import { ActionModal } from '$lib/components/admin';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        token: string;
        onClose: () => void;
    }

    let { token, onClose }: Props = $props();

    let tokenCopied = $state(false);

    // The real origin, not a placeholder host, so the example can be pasted.
    const origin = typeof window === 'undefined' ? '' : window.location.origin;

    async function copyToken() {
        try {
            // navigator.clipboard is undefined on plain-HTTP origins (LAN
            // installs); the throw lands in the catch and the admin is told
            // to copy the (selectable) text by hand.
            await navigator.clipboard.writeText(token);
            tokenCopied = true;
            toasts.success(m.admin_conn_copied());
        } catch {
            tokenCopied = false;
            toasts.error(m.admin_conn_copy_failed());
        }
    }
</script>

<!--
    No `onclose`: Escape and a backdrop click must not dismiss the one and
    only display of the token before the admin has copied it (admin/users
    review 2026-10-07, item 8b). The custom footer carries the single Close.
-->
<ActionModal title={m.settings_tokens_result_title()}>
    {#snippet footer()}
        <button type="button" class="btn btn-green w-full font-medium" onclick={onClose}>
            {m.close()}
        </button>
    {/snippet}
    <div class="bg-yellow-900/30 border border-yellow-600 rounded-lg p-4 mb-4">
        <div class="flex items-start gap-3">
            <Icon src={ExclamationTriangle} class="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
            <p class="text-sm text-yellow-200">
                {m.settings_tokens_result_warning()}
            </p>
        </div>
    </div>

    <div class="bg-surface-900 rounded-lg p-4 mb-4">
        <div class="flex items-center gap-2">
            <code class="text-sm text-green-400 break-all flex-1 font-mono select-all">
                {token}
            </code>
            <button
                class="shrink-0 p-2 rounded hover:bg-surface-700 transition-colors"
                onclick={copyToken}
                title={m.admin_conn_copy_token()}
                aria-label={m.admin_conn_copy_token()}>
                {#if tokenCopied}
                    <Icon src={Check} class="w-5 h-5 text-green-400" />
                {:else}
                    <Icon src={ClipboardDocument} class="w-5 h-5 text-surface-400" />
                {/if}
            </button>
        </div>
    </div>

    <div class="text-muted space-y-2">
        <p><strong>{m.admin_token_usage_example()}</strong></p>
        <pre
            class="bg-surface-900 rounded p-3 text-xs overflow-x-auto">curl -H "Authorization: Bearer {token.substring(
                0,
                20,
            )}..." \
     {origin || 'https://your-server'}/api/v1/sessions</pre>
    </div>
</ActionModal>
