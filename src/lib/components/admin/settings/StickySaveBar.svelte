<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ExclamationTriangle, ArrowPath, Check } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        modifiedCount: number;
        /**
         * @deprecated Unused by this component. Retained as an optional prop only
         * so existing callers that still pass it do not break; new callers should
         * omit it. Remove once no caller passes it.
         */
        currentValues?: Record<string, unknown>;
        isSaving?: boolean;
        ondiscard?: () => void;
        onsave?: () => void;
    }

    let { modifiedCount, isSaving = false, ondiscard, onsave }: Props = $props();

    function handleDiscard() {
        ondiscard?.();
    }

    function handleSave() {
        onsave?.();
    }
</script>

<div
    class="fixed bottom-0 left-0 right-0 bg-surface-900/95 border-t border-surface-700 p-4 z-50 backdrop-blur-sm">
    <div class="container mx-auto between">
        <span class="text-sm text-yellow-400 flex items-center gap-2">
            <Icon src={ExclamationTriangle} class="w-4 h-4" />
            {modifiedCount === 1
                ? m.admin_sticky_unsaved_changes_one({ count: modifiedCount })
                : m.admin_sticky_unsaved_changes_many({ count: modifiedCount })}
        </span>
        <div class="flex items-center gap-3">
            <button
                type="button"
                class="px-3 py-2 text-muted hover:text-white transition-colors"
                disabled={isSaving}
                onclick={handleDiscard}>
                {m.admin_sticky_discard()}
            </button>
            <button
                type="button"
                class="flex items-center gap-2 px-4 py-2 text-sm bg-yellow-500 hover:bg-yellow-400 text-surface-900 font-medium rounded-lg transition-colors disabled:opacity-50"
                disabled={isSaving}
                onclick={handleSave}>
                {#if isSaving}
                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                    {m.admin_sticky_saving()}
                {:else}
                    <Icon src={Check} class="w-4 h-4" />
                    {m.admin_sticky_save_changes()}
                {/if}
            </button>
        </div>
    </div>
</div>
