<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';
    import { Icon, ExclamationTriangle } from 'svelte-hero-icons';
    import { resetUserData } from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import { bodyPortal } from '$lib/utils/body-portal';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { Z } from '$lib/utils/z-index';
    import { trapFocus } from '$lib/utils/focus-trap';
    import SettingsGroup from './SettingsGroup.svelte';
    import SettingRow from './SettingRow.svelte';
    import { resolve } from '$lib/paths';
    import { RESET_ACTIONS, DESTRUCTIVE_ACTIONS } from '$lib/schemas/api-user-data-reset';

    type Action = (typeof RESET_ACTIONS)[number];

    interface Props {
        jellyfinSyncEnabled?: boolean;
    }
    let { jellyfinSyncEnabled = false }: Props = $props();

    // There is no `features.music` flag — AppFeatures (src/app.d.ts) has no
    // `music` key, only feature-specific ones (musicAlchemy, musicMap, ...).
    // The real "does a music library exist" signal is `activeLibraryTypes`,
    // returned by the root layout load and consumed the same way by
    // Sidebar.svelte's `activeLibSet.has('music')` gate.
    const activeLibraryTypes = $derived(
        Array.isArray($page.data?.activeLibraryTypes)
            ? ($page.data.activeLibraryTypes as string[])
            : [],
    );
    const musicEnabled = $derived(activeLibraryTypes.includes('music'));

    let busy = $state<Action | null>(null);
    // Type-to-confirm modal state for destructive actions.
    let pending = $state<{ action: Action; label: string } | null>(null);
    let confirmText = $state('');
    let feedback = $state<{ message: string; error: boolean } | null>(null);

    // The word to type is translated ("ZURÜCKSETZEN" in German); the English
    // "RESET" is accepted too so muscle memory and old instructions still work.
    const CONFIRM_WORD = m.settings_data_confirm_word().trim();
    function confirmMatches(text: string): boolean {
        const t = text.trim().toUpperCase();
        return t === CONFIRM_WORD.toUpperCase() || t === 'RESET';
    }

    async function perform(action: Action): Promise<void> {
        if (busy !== null) return;
        busy = action;
        feedback = null;
        try {
            const { error } = await resetUserData(
                action,
                DESTRUCTIVE_ACTIONS.has(action) ? true : undefined,
            );
            feedback = { message: error || m.settings_data_toast_success(), error: !!error };
            if (error) toasts.error(error);
            else toasts.success(m.settings_data_toast_success());
        } catch {
            feedback = { message: m.settings_data_toast_error(), error: true };
            toasts.error(m.settings_data_toast_error());
        } finally {
            busy = null;
        }
    }

    function onClick(action: Action, label: string): void {
        if (busy !== null) return;
        if (DESTRUCTIVE_ACTIONS.has(action)) {
            pending = { action, label };
            confirmText = '';
        } else {
            void perform(action);
        }
    }

    function cancelConfirm(): void {
        pending = null;
        confirmText = '';
    }

    async function confirmDestructive(): Promise<void> {
        if (!pending || !confirmMatches(confirmText) || busy !== null) return;
        const action = pending.action;
        pending = null;
        confirmText = '';
        await perform(action);
    }

    function onKeydown(event: KeyboardEvent): void {
        if (pending && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancelConfirm();
        }
    }
</script>

<svelte:window onkeydown={onKeydown} />

{#if feedback}
    <p
        role={feedback.error ? 'alert' : 'status'}
        class="mb-4 text-sm {feedback.error ? 'text-error-400' : 'text-success-400'}">
        {feedback.message}
    </p>
{/if}

{#if musicEnabled}
    <SettingsGroup
        label={m.settings_data_heading_music()}
        description={m.settings_data_music_description()}>
        <SettingRow
            label={m.settings_data_btn_clear_listening_history_label()}
            hint={m.settings_data_hint_clear_listening_history()}>
            {#snippet control()}
                <button
                    class="btn btn-sm variant-ghost-error"
                    disabled={busy !== null}
                    onclick={() =>
                        onClick(
                            'music-history',
                            m.settings_data_btn_clear_listening_history_label(),
                        )}>
                    {busy === 'music-history'
                        ? m.settings_data_busy()
                        : m.settings_data_btn_clear()}
                </button>
            {/snippet}
        </SettingRow>
        <SettingRow
            label={m.settings_data_btn_clear_feedback_label()}
            hint={m.settings_data_hint_clear_feedback()}>
            {#snippet control()}
                <button
                    class="btn btn-sm variant-ghost-error"
                    disabled={busy !== null}
                    onclick={() =>
                        onClick('music-feedback', m.settings_data_btn_clear_feedback_label())}>
                    {busy === 'music-feedback'
                        ? m.settings_data_busy()
                        : m.settings_data_btn_clear()}
                </button>
            {/snippet}
        </SettingRow>
        <SettingRow
            label={m.settings_data_btn_refresh_music_recs_label()}
            hint={m.settings_data_hint_refresh_music_recs()}>
            {#snippet control()}
                <button
                    class="btn btn-sm variant-filled-surface"
                    disabled={busy !== null}
                    onclick={() =>
                        onClick('music-recs', m.settings_data_btn_refresh_music_recs_label())}>
                    {busy === 'music-recs' ? m.settings_data_busy() : m.settings_data_btn_refresh()}
                </button>
            {/snippet}
        </SettingRow>
    </SettingsGroup>
{/if}

<SettingsGroup
    label={m.settings_data_heading_video()}
    description={m.settings_data_video_description()}>
    <!-- Any two-way sync can bring cleared history back, not only Jellyfin —
         Trakt and MyAnimeList pull watched state too. -->
    <div
        class="flex items-start gap-2 rounded-lg p-3 m-4 mb-0 {jellyfinSyncEnabled
            ? 'bg-warning-900/30 border border-warning-600'
            : 'bg-surface-900/40'}">
        <Icon
            src={ExclamationTriangle}
            class="w-4 h-4 shrink-0 mt-0.5 {jellyfinSyncEnabled
                ? 'text-warning-400'
                : 'text-surface-400'}" />
        <p class="text-xs {jellyfinSyncEnabled ? 'text-warning-200' : 'text-surface-300'}">
            {m.settings_data_sync_warning()}
            <a href={resolve('/settings/connections')} class="underline"
                >{m.settings_data_sync_warning_link()}</a>
        </p>
    </div>
    <SettingRow
        label={m.settings_data_btn_clear_continue_watching_label()}
        hint={m.settings_data_hint_clear_continue_watching()}>
        {#snippet control()}
            <button
                class="btn btn-sm variant-filled-surface"
                disabled={busy !== null}
                onclick={() =>
                    onClick('vod-resume', m.settings_data_btn_clear_continue_watching_label())}>
                {busy === 'vod-resume' ? m.settings_data_busy() : m.settings_data_btn_clear()}
            </button>
        {/snippet}
    </SettingRow>
    <SettingRow
        label={m.settings_data_btn_clear_watch_history_label()}
        hint={m.settings_data_hint_clear_watch_history()}>
        {#snippet control()}
            <button
                class="btn btn-sm variant-ghost-error"
                disabled={busy !== null}
                onclick={() =>
                    onClick('vod-history', m.settings_data_btn_clear_watch_history_label())}>
                {busy === 'vod-history' ? m.settings_data_busy() : m.settings_data_btn_clear()}
            </button>
        {/snippet}
    </SettingRow>
    <SettingRow
        label={m.settings_data_btn_reset_video_recs_label()}
        hint={m.settings_data_hint_reset_video_recs()}>
        {#snippet control()}
            <button
                class="btn btn-sm variant-filled-surface"
                disabled={busy !== null}
                onclick={() => onClick('vod-recs', m.settings_data_btn_reset_video_recs_label())}>
                {busy === 'vod-recs' ? m.settings_data_busy() : m.settings_data_btn_reset()}
            </button>
        {/snippet}
    </SettingRow>
</SettingsGroup>

{#if pending}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        use:bodyPortal
        class="modal-overlay modal-overlay-blur p-4"
        style="z-index: {Z.MODAL}"
        onclick={cancelConfirm}>
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
            class="bg-surface-800 rounded-lg shadow-xl max-w-md w-full p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="data-reset-title"
            aria-describedby="data-reset-warning"
            tabindex="-1"
            use:trapFocus
            onclick={stopPropagation()}>
            <h3 id="data-reset-title" class="text-xl font-semibold mb-2">{pending.label}</h3>
            <p id="data-reset-warning" class="text-sm text-error-300 mb-4">
                {m.viewer_settings_reset_warning()}
            </p>
            <p class="text-sm text-surface-300 mb-4">
                {m.settings_data_modal_confirm_prefix()}
                <strong>{CONFIRM_WORD}</strong>
                {m.settings_data_modal_confirm_suffix()}
            </p>
            <label for="data-reset-confirm-input" class="sr-only">
                {m.settings_data_modal_confirm_sr_label({ word: CONFIRM_WORD })}
            </label>
            <input
                id="data-reset-confirm-input"
                type="text"
                class="input w-full"
                placeholder={CONFIRM_WORD}
                autocomplete="off"
                spellcheck="false"
                bind:value={confirmText} />
            <div class="flex gap-3 justify-end mt-6">
                <button data-autofocus class="btn variant-ghost-surface" onclick={cancelConfirm}
                    >{m.settings_data_modal_cancel()}</button>
                <button
                    class="btn variant-filled-error"
                    disabled={!confirmMatches(confirmText) || busy !== null}
                    onclick={confirmDestructive}>
                    {m.settings_data_modal_confirm()}
                </button>
            </div>
        </div>
    </div>
{/if}
