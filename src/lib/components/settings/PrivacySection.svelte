<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Privacy — what other people on this server can see about you.

  These three switches used to live inside the Display settings page, between the
  interface preferences and the recommendation dampers. They are not display
  preferences: they decide what other users can see, and burying them under
  "Display" meant the person they protect had no single place to read their own
  privacy state.

  Presented in the order the server's visibility predicate actually evaluates
  them (`social-visibility.builder.ts`), so the page reads as one model rather
  than three unrelated toggles:

    1. Hide my streams — the master opt-out. Outranks everything below it.
    2. Audiobook activity — the audiobook-wide switch.
    3. Listening activity — the reciprocal coarse tier, which additionally
       requires the person looking to be sharing too.

  The nesting is deliberate: 2 and 3 are shown as dependent on the one above,
  because that is how the predicate treats them. A user who turns off audiobook
  sharing has already turned off listening activity, and the UI should not
  pretend otherwise.
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon, EyeSlash, UserGroup, Users } from 'svelte-hero-icons';
    import SettingsGroup from './SettingsGroup.svelte';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import * as userApi from '$lib/api/user';
    import * as m from '$lib/paraglide/messages.js';

    let hideStreams = $state(true);
    let privacyLoading = $state(false);
    let shareListeningActivity = $state(false);
    let shareAudiobookActivity = $state(false);
    let listeningCircleConfigured = $state(false);
    let listeningActivityLoading = $state(false);
    /**
     * Until the first read lands, every toggle is disabled. A privacy control must
     * never be interactive while showing a value it has not actually read — a click
     * in that window would write the placeholder back as if it were the user's
     * choice, and `privacy_prefs_updated_at` would then record it as explicit.
     */
    let loaded = $state(false);

    async function loadStreamPrivacy(): Promise<void> {
        try {
            const { data } = await userApi.getStreamPrivacy();
            const payload = (data ?? {}) as Record<string, unknown>;
            const nested =
                payload && typeof payload.data === 'object' && payload.data !== null
                    ? (payload.data as Record<string, unknown>)
                    : payload;
            hideStreams = typeof nested.hideFromOthers === 'boolean' ? nested.hideFromOthers : true;
            shareListeningActivity = nested.shareListeningActivity === true;
            shareAudiobookActivity = nested.shareAudiobookActivity === true;
            listeningCircleConfigured = nested.listeningCircleConfigured === true;
            loaded = true;
        } catch {
            // Leave `loaded` false: the toggles stay disabled rather than offering
            // to write a value we never read.
        }
    }

    onMount(() => {
        void loadStreamPrivacy();
    });

    async function toggleStreamPrivacy(): Promise<void> {
        if (privacyLoading || !loaded) return;
        const prev = hideStreams;
        hideStreams = !hideStreams;
        privacyLoading = true;
        try {
            const { error } = await userApi.updateStreamPrivacy({ hideFromOthers: hideStreams });
            if (error) hideStreams = prev;
        } catch {
            hideStreams = prev;
        } finally {
            privacyLoading = false;
        }
    }

    async function toggleAudiobookSharing(): Promise<void> {
        if (listeningActivityLoading || !loaded) return;
        const previous = shareAudiobookActivity;
        shareAudiobookActivity = !shareAudiobookActivity;
        listeningActivityLoading = true;
        try {
            const { data, error } = await userApi.updateStreamPrivacy({
                shareAudiobookActivity,
            });
            // Only adopt the server's value when it actually sent one. `else if
            // (data)` alone wrote `undefined` into the state whenever the response
            // shape lost the field, which renders as "off" and then gets saved back
            // as a real choice on the next click.
            if (error) shareAudiobookActivity = previous;
            else if (typeof data?.shareAudiobookActivity === 'boolean')
                shareAudiobookActivity = data.shareAudiobookActivity;
        } catch {
            shareAudiobookActivity = previous;
        } finally {
            listeningActivityLoading = false;
        }
    }

    async function toggleListeningActivity(): Promise<void> {
        if (
            listeningActivityLoading ||
            !loaded ||
            !listeningCircleConfigured ||
            !shareAudiobookActivity
        )
            return;
        const previous = shareListeningActivity;
        shareListeningActivity = !shareListeningActivity;
        listeningActivityLoading = true;
        try {
            const { data, error } = await userApi.updateStreamPrivacy({
                shareListeningActivity,
            });
            if (error) shareListeningActivity = previous;
            else if (typeof data?.shareListeningActivity === 'boolean')
                shareListeningActivity = data.shareListeningActivity;
        } catch {
            shareListeningActivity = previous;
        } finally {
            listeningActivityLoading = false;
        }
    }

    // Mirrors the predicate: `hide_streams` outranks the audiobook switch, which
    // outranks the reciprocal tier. Shown as disabled rather than hidden so the
    // user can see WHY a switch is inactive.
    let audiobookDisabled = $derived(listeningActivityLoading || !loaded || hideStreams);
    let listeningDisabled = $derived(
        listeningActivityLoading ||
            !loaded ||
            hideStreams ||
            !listeningCircleConfigured ||
            !shareAudiobookActivity,
    );
</script>

<!-- Two groups instead of one labelled "Privacy" under a page titled "Privacy". -->
<SettingsGroup label={m.settings_privacy_group_watching()}>
    <div class="between py-3 px-4 gap-4">
        <div class="flex items-center gap-2 min-w-0">
            <Icon src={EyeSlash} class="w-4 h-4 text-surface-400 shrink-0" />
            <div class="min-w-0">
                <span class="text-sm">{m.settings_display_hide_my_streams()}</span>
                <p class="text-xs text-surface-400 mt-0.5">
                    {m.settings_privacy_hide_streams_hint()}
                </p>
            </div>
        </div>
        <Toggle
            label={m.settings_display_hide_my_streams()}
            checked={hideStreams}
            disabled={privacyLoading || !loaded}
            onchange={toggleStreamPrivacy} />
    </div>
</SettingsGroup>

<SettingsGroup
    label={m.settings_privacy_group_audiobooks()}
    description={m.settings_privacy_audiobooks_description()}>
    <div class="between py-3 px-4 gap-4">
        <div class="flex items-center gap-2 min-w-0">
            <Icon src={UserGroup} class="w-4 h-4 text-surface-400 shrink-0" />
            <div class="min-w-0">
                <span class="text-sm">{m.settings_audiobook_sharing_title()}</span>
                <p class="text-xs text-surface-400 mt-0.5">
                    {loaded && hideStreams
                        ? m.settings_privacy_overridden_by_hide_streams()
                        : m.settings_audiobook_sharing_hint()}
                </p>
            </div>
        </div>
        <Toggle
            label={m.settings_audiobook_sharing_title()}
            checked={shareAudiobookActivity && !hideStreams}
            disabled={audiobookDisabled}
            onchange={toggleAudiobookSharing} />
    </div>

    <div class="between py-3 px-4 gap-4">
        <div class="flex items-center gap-2 min-w-0">
            <Icon src={Users} class="w-4 h-4 text-surface-400 shrink-0" />
            <div class="min-w-0">
                <span class="text-sm">{m.settings_listening_activity_title()}</span>
                <p class="text-xs text-surface-400 mt-0.5">
                    {#if !loaded}
                        <!-- Gated on `loaded`: every branch below asserts something
                             about the server's state, and before the first read lands
                             the placeholders would render "an administrator must
                             configure a listening circle first" on an install where
                             one is configured. Show the neutral description until we
                             actually know. -->
                        {m.settings_listening_activity_hint()}
                    {:else if hideStreams}
                        {m.settings_privacy_overridden_by_hide_streams()}
                    {:else if !listeningCircleConfigured}
                        {m.settings_listening_activity_unavailable()}
                    {:else if !shareAudiobookActivity}
                        {m.settings_privacy_requires_audiobook_sharing()}
                    {:else}
                        {m.settings_listening_activity_hint()}
                    {/if}
                </p>
            </div>
        </div>
        <Toggle
            label={m.settings_listening_activity_title()}
            checked={shareListeningActivity && shareAudiobookActivity && !hideStreams}
            disabled={listeningDisabled}
            onchange={toggleListeningActivity} />
    </div>
    {#snippet footer()}
        <p class="text-xs text-surface-400">{m.settings_privacy_per_item_note()}</p>
    {/snippet}
</SettingsGroup>
