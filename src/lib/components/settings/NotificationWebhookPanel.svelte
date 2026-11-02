<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The caller's own outbound notification endpoint (ntfy / Gotify / Discord /
  Home Assistant shaped).

  Two rules this panel exists to obey:

  1. **Nothing is interactive until the first read lands.** Same rule as
     PrivacySection and the browser-notifications toggle one group up, for the
     same reason: a click before the GET returns would write a placeholder over
     whatever the user actually has stored. Here that would mean overwriting a
     working endpoint with an empty string.
  2. **The signing secret is shown exactly once.** The server returns it in the
     response to the save and never again — `GET` cannot produce it. So the
     panel holds it in local state for as long as the page is open and says so,
     rather than pretending it can be retrieved later.

  Visibility is the PARENT's job (`features.userNotificationWebhooks`), because
  the admin gate is a page-data flag and this component should not have to
  render an "unavailable" state for the overwhelmingly common case where the
  operator never turned the feature on.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon, Bolt } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { toasts } from '$lib/stores/toast.store';
    import * as userApi from '$lib/api/user';
    import RevealableSecret from './RevealableSecret.svelte';

    /** Endpoint currently stored server-side; '' when none is configured. */
    let savedUrl = $state('');
    /** The edit buffer. */
    let url = $state('');
    /**
     * Whether the first GET has come back SUCCESSFULLY. Every control below
     * is disabled until it has — see rule 1 in the component header. This
     * only ever flips true from a successful `load()`; it is deliberately
     * NOT set in a `finally`, because a failed read must leave the panel
     * exactly as inert as it was before the request — see `loadFailed`.
     */
    let loaded = $state(false);
    /**
     * True when the most recent `load()` failed (network blip, 5xx) rather
     * than succeeding with "no endpoint configured". Without this, a failed
     * read on a user who already has a saved endpoint would render an empty
     * field with Save unlocked — a click would then upsert the empty value,
     * silently replacing their URL and re-signing the secret with no
     * indication the read ever failed. `loaded` stays false in this state too
     * (belt and suspenders: `canSave`/`canClear` only need one of the two),
     * but this is what the retry affordance renders off.
     */
    let loadFailed = $state(false);
    let busy = $state(false);
    /**
     * Operator-side state as the SERVER sees it. The parent already gates on
     * the same flag from page data, but page data is captured at navigation and
     * this read is live, so a flag flipped mid-session surfaces here as a
     * "saved but dormant" note rather than as a silent no-op.
     */
    let enabled = $state(true);
    /** Set once, by a successful save. Never fetched — the server cannot re-issue it. */
    let freshSecret = $state('');

    const dirty = $derived(url.trim() !== savedUrl);
    const canSave = $derived(loaded && !busy && url.trim().length > 0 && dirty);
    const canClear = $derived(loaded && !busy && savedUrl !== '');

    async function load(): Promise<void> {
        loadFailed = false;
        try {
            const { data, error } = await userApi.getNotificationWebhook();
            if (!error && data) {
                savedUrl = data.url ?? '';
                url = savedUrl;
                enabled = data.enabled;
                loaded = true;
                return;
            }
            loadFailed = true;
        } catch {
            loadFailed = true;
        }
        // NOT `loaded = true` here — a failed read must keep Save/Clear
        // disabled (rule 1), or a click could upsert an empty field over a
        // working saved endpoint. `retry()` is the only way out of this state.
    }

    async function retry(): Promise<void> {
        await load();
    }

    async function save(): Promise<void> {
        if (!canSave) return;
        busy = true;
        try {
            const { data, error } = await userApi.setNotificationWebhook({ url: url.trim() });
            if (error || !data) {
                // The SSRF guard's rejection arrives as a 422 with the reason in
                // the problem detail — surface it verbatim rather than a generic
                // failure, because "which part of your URL was refused" is the
                // entire value of validating at save time.
                toasts.error(error ?? m.settings_webhook_title());
                return;
            }
            savedUrl = data.url ?? '';
            url = savedUrl;
            enabled = data.enabled;
            freshSecret = data.secret ?? '';
            toasts.info(m.settings_webhook_saved());
        } finally {
            busy = false;
        }
    }

    async function clear(): Promise<void> {
        if (!canClear) return;
        busy = true;
        try {
            const { error } = await userApi.clearNotificationWebhook();
            if (error) {
                toasts.error(error);
                return;
            }
            savedUrl = '';
            url = '';
            freshSecret = '';
            toasts.info(m.settings_webhook_cleared());
        } finally {
            busy = false;
        }
    }

    onMount(() => {
        void load();
    });
</script>

<div class="px-4 py-3">
    <div class="flex items-start gap-2">
        <Icon src={Bolt} class="w-4 h-4 text-surface-400 shrink-0 mt-0.5" />
        <div class="min-w-0 flex-1">
            <span class="text-sm">{m.settings_webhook_title()}</span>
            <p class="text-xs text-surface-500 mt-0.5">{m.settings_webhook_hint()}</p>

            <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                    type="url"
                    class="input input-sm flex-1 text-sm"
                    aria-label={m.settings_webhook_url_label()}
                    placeholder={m.settings_webhook_url_placeholder()}
                    bind:value={url}
                    disabled={!loaded || busy} />
                <div class="flex gap-2">
                    <button
                        type="button"
                        class="btn btn-sm variant-filled-primary text-xs"
                        disabled={!canSave}
                        onclick={save}>
                        {m.settings_webhook_save()}
                    </button>
                    <button
                        type="button"
                        class="btn btn-sm variant-ghost-error text-xs"
                        disabled={!canClear}
                        onclick={clear}>
                        {m.settings_webhook_clear()}
                    </button>
                </div>
            </div>

            {#if loadFailed}
                <p class="text-xs text-error-400 mt-2 flex items-center gap-2">
                    <span>{m.settings_webhook_load_error()}</span>
                    <button
                        type="button"
                        class="btn btn-sm variant-ghost text-xs"
                        disabled={busy}
                        onclick={retry}>
                        {m.common_retry()}
                    </button>
                </p>
            {/if}

            {#if loaded && !enabled}
                <p class="text-xs text-warning-400 mt-2">
                    {savedUrl
                        ? m.settings_webhook_dormant()
                        : m.settings_webhook_disabled_by_admin()}
                </p>
            {/if}

            {#if freshSecret}
                <div class="mt-3">
                    <p class="text-xs text-surface-500 mb-1">
                        {m.settings_webhook_secret_once()}
                    </p>
                    <!-- `load` can never produce the value: the server stores it
                         encrypted and has no read path for it. Resolving null is
                         exactly the component's "exists but cannot be shown" case. -->
                    {#key freshSecret}
                        <RevealableSecret
                            initial={freshSecret}
                            load={() => Promise.resolve(null)}
                            unavailableText={m.settings_webhook_secret_once()} />
                    {/key}
                </div>
            {/if}

            <p class="text-xs text-surface-600 mt-3">{m.settings_webhook_format_note()}</p>
        </div>
    </div>
</div>
