<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount, tick } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import {
        playbackPreferences,
        updatePreference,
        updatePreferences,
    } from '$lib/components/player/preferences-sync.svelte';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import SettingsGroup from './SettingsGroup.svelte';
    import SavedCue from './SavedCue.svelte';
    import PreferenceSettingsGate from './PreferenceSettingsGate.svelte';
    import SubtitleAppearanceEditor from './SubtitleAppearanceEditor.svelte';
    import { languagePreferenceOptions, matchingOptionValue } from './language-options';

    interface Props {
        highlight?: string;
    }
    let { highlight = '' }: Props = $props();

    let savedAt = $state(0);
    function flashSaved(): void {
        if (playbackPreferences.ready && !playbackPreferences.storageUnavailable)
            savedAt = Date.now();
    }

    function rowClass(id: string): string {
        const on = id !== '' && highlight === id;
        return `scroll-mt-24 ${on ? 'ring-2 ring-primary-500/60 rounded-lg' : ''}`;
    }

    const locale = getLocale();
    const languageOptions = $derived(
        languagePreferenceOptions(locale, playbackPreferences.subtitleLanguage),
    );

    onMount(async () => {
        if (highlight) {
            await tick();
            document.getElementById(`subtitles-${highlight}`)?.scrollIntoView({ block: 'center' });
        }
    });
</script>

{#snippet toggleRow(label: string, hint: string, checked: boolean, onchange: () => void)}
    <div class="flex items-center justify-between gap-4 py-3 px-4">
        <div class="min-w-0">
            <span class="text-sm">{label}</span>
            {#if hint}
                <p class="text-xs text-surface-400 mt-0.5">{hint}</p>
            {/if}
        </div>
        <div class="shrink-0">
            <Toggle {label} {checked} {onchange} />
        </div>
    </div>
{/snippet}

<!-- Zero-height anchor: the "Saved" cue floats beside the page title instead
     of reserving an empty row above the first group. -->
<div class="relative h-0">
    <div class="absolute right-0 -top-12">
        <SavedCue {savedAt} />
    </div>
</div>

<PreferenceSettingsGate>
    <SettingsGroup label={m.settings_subtitles_defaults_label()}>
        <div
            id="subtitles-language"
            class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 px-4 {rowClass(
                'language',
            )}">
            <span class="text-sm">{m.settings_subtitles_default_language_label()}</span>
            <select
                class="select select-sm w-auto max-w-full"
                aria-label={m.settings_subtitles_default_language_label()}
                value={matchingOptionValue(playbackPreferences.subtitleLanguage)}
                onchange={(e) => {
                    updatePreferences({
                        subtitleLanguage: e.currentTarget.value || null,
                        subtitleTrackHint: null,
                    });
                    flashSaved();
                }}>
                <option value="">{m.settings_language_no_preference()}</option>
                {#each languageOptions as o (o.value)}
                    <option value={o.value}>{o.label}</option>
                {/each}
            </select>
        </div>
        {@render toggleRow(
            m.settings_subtitles_show_label(),
            m.settings_subtitles_show_hint(),
            playbackPreferences.subtitlesEnabled,
            () => {
                updatePreference('subtitlesEnabled', !playbackPreferences.subtitlesEnabled);
                flashSaved();
            },
        )}
        {@render toggleRow(
            m.settings_subtitles_forced_label(),
            m.settings_subtitles_forced_hint(),
            playbackPreferences.forcedSubtitlesEnabled,
            () => {
                updatePreference(
                    'forcedSubtitlesEnabled',
                    !playbackPreferences.forcedSubtitlesEnabled,
                );
                flashSaved();
            },
        )}
    </SettingsGroup>

    <SettingsGroup
        label={m.settings_subtitles_appearance_label()}
        description={m.settings_subtitles_appearance_description()}>
        <div id="subtitles-appearance" class={rowClass('appearance')}>
            <SubtitleAppearanceEditor onchange={flashSaved} />
        </div>
    </SettingsGroup>
</PreferenceSettingsGate>
