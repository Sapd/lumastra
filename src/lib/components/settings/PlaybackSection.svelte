<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import {
        playbackPreferences,
        updatePreference,
    } from '$lib/components/player/preferences-sync.svelte';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import SettingsGroup from './SettingsGroup.svelte';
    import SavedCue from './SavedCue.svelte';
    import PreferenceSettingsGate from './PreferenceSettingsGate.svelte';
    import NumberPreference from './NumberPreference.svelte';
    import {
        QUALITY_MODE_OPTIONS,
        RESOLUTION_OPTIONS,
        MAX_BITRATE_OPTIONS,
        isFixedMode,
    } from './playback-options';
    import { languagePreferenceOptions, matchingOptionValue } from './language-options';

    interface Props {
        /** Deep-link target control id (without the "playback-" prefix). */
        highlight?: string;
    }
    let { highlight = '' }: Props = $props();

    let savedAt = $state(0);
    function flashSaved(): void {
        if (playbackPreferences.ready && !playbackPreferences.storageUnavailable)
            savedAt = Date.now();
    }

    type QualityMode = 'original' | 'auto' | 'fixed';

    function setMode(value: QualityMode): void {
        updatePreference('qualityMode', value);
        flashSaved();
    }

    // Localized labels for the quality-mode options (the option data keeps
    // English labels as the stable identity; the UI resolves them per locale).
    function qualityLabel(value: QualityMode): string {
        return value === 'original'
            ? m.settings_quality_original()
            : value === 'auto'
              ? m.settings_quality_auto()
              : m.settings_quality_fixed();
    }

    function qualityHint(value: QualityMode): string {
        return value === 'original'
            ? m.settings_quality_original_hint()
            : value === 'auto'
              ? m.settings_quality_auto_hint()
              : m.settings_quality_fixed_hint();
    }

    /**
     * "Auto" only works where the operator enabled adaptive quality
     * (FEATURE_PLAYER_AUTO_QUALITY, off by default). Elsewhere the player
     * ignores a saved "auto" and plays the original, so offering it here was a
     * button that did nothing. Still shown while it is the saved choice, so the
     * selection never renders as "nothing selected".
     */
    const autoAvailable = $derived($page.data?.features?.playerAutoQuality !== false);
    const qualityOptions = $derived(
        QUALITY_MODE_OPTIONS.filter(
            (o) =>
                o.value !== 'auto' || autoAvailable || playbackPreferences.qualityMode === 'auto',
        ),
    );

    const locale = getLocale();
    const audioLanguageOptions = $derived(
        languagePreferenceOptions(locale, playbackPreferences.audioLanguage),
    );

    function isHighlighted(id: string): boolean {
        // An id-less row must never match the empty default `highlight`.
        return id !== '' && highlight === id;
    }

    function rowClass(id: string): string {
        return `scroll-mt-24 ${isHighlighted(id) ? 'ring-2 ring-primary-500/60 rounded-lg' : ''}`;
    }

    onMount(async () => {
        if (highlight) {
            await tick();
            document.getElementById(`playback-${highlight}`)?.scrollIntoView({ block: 'center' });
        }
    });
</script>

<!--
  One row shape for every switch: label + hint on the left, the switch pinned
  right. Rows used to mix `flex-wrap` with and without hints, so on a phone some
  switches sat right-aligned and others dropped under their label.
-->
{#snippet toggleRow(
    id: string,
    label: string,
    hint: string,
    checked: boolean,
    onchange: () => void,
)}
    <div
        id={id ? `playback-${id}` : undefined}
        class="flex items-center justify-between gap-4 py-3 px-4 {rowClass(id)}">
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
    <SettingsGroup label={m.settings_playback_group_audio()}>
        {@render toggleRow(
            'prefer-original-audio',
            m.settings_playback_prefer_original_audio(),
            m.settings_playback_prefer_original_audio_hint(),
            playbackPreferences.preferOriginalAudio,
            () => {
                updatePreference('preferOriginalAudio', !playbackPreferences.preferOriginalAudio);
                flashSaved();
            },
        )}
        <div
            id="playback-audio-language"
            class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 px-4 {rowClass(
                'audio-language',
            )}">
            <div class="min-w-0">
                <span class="text-sm">{m.settings_playback_audio_default()}</span>
                <p class="text-xs text-surface-400 mt-0.5">
                    {m.settings_playback_audio_default_hint()}
                </p>
            </div>
            <select
                class="select select-sm w-auto max-w-full"
                aria-label={m.settings_playback_audio_default()}
                value={matchingOptionValue(playbackPreferences.audioLanguage)}
                onchange={(e) => {
                    updatePreference('audioLanguage', e.currentTarget.value || null);
                    flashSaved();
                }}>
                <option value="">{m.settings_language_no_preference()}</option>
                {#each audioLanguageOptions as o (o.value)}
                    <option value={o.value}>{o.label}</option>
                {/each}
            </select>
        </div>
    </SettingsGroup>

    <SettingsGroup
        label={m.settings_playback_group_quality()}
        description={m.settings_playback_quality_description()}>
        <div id="playback-quality" class="px-4 py-3 {rowClass('quality')}">
            <div
                class="flex flex-wrap gap-2"
                role="group"
                aria-label={m.settings_playback_group_quality()}>
                {#each qualityOptions as opt (opt.value)}
                    <button
                        aria-pressed={playbackPreferences.qualityMode === opt.value}
                        class="btn btn-sm {playbackPreferences.qualityMode === opt.value
                            ? 'variant-filled-primary'
                            : 'variant-ghost-surface'}"
                        onclick={() => setMode(opt.value)}>
                        {qualityLabel(opt.value)}
                    </button>
                {/each}
            </div>
            <p class="text-xs text-surface-400 mt-2" aria-live="polite">
                {qualityHint(playbackPreferences.qualityMode)}
            </p>
        </div>
        {#if isFixedMode(playbackPreferences.qualityMode)}
            <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 px-4">
                <span class="text-sm">{m.settings_playback_max_bitrate()}</span>
                <select
                    aria-label={m.settings_playback_max_bitrate()}
                    class="select select-sm w-auto"
                    value={playbackPreferences.maxBitrateBps ?? ''}
                    onchange={(e) => {
                        const v = e.currentTarget.value;
                        updatePreference('maxBitrateBps', v ? Number(v) : null);
                        flashSaved();
                    }}>
                    <option value="">{m.settings_playback_bitrate_auto()}</option>
                    {#each MAX_BITRATE_OPTIONS as o (o.value)}
                        <option value={o.value}>{o.label}</option>
                    {/each}
                </select>
            </div>
        {/if}
        <!-- Original plays the file as it is; a resolution preference only means
         something once the server is converting. -->
        {#if playbackPreferences.qualityMode !== 'original'}
            <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 px-4">
                <span class="text-sm">{m.settings_playback_pref_resolution()}</span>
                <select
                    aria-label={m.settings_playback_pref_resolution()}
                    class="select select-sm w-auto"
                    value={playbackPreferences.preferredResolution ?? ''}
                    onchange={(e) => {
                        const v = e.currentTarget.value;
                        updatePreference('preferredResolution', v || null);
                        flashSaved();
                    }}>
                    {#each RESOLUTION_OPTIONS as o (o.label)}
                        <option value={o.value ?? ''}
                            >{o.value === null ? m.settings_resolution_auto() : o.label}</option>
                    {/each}
                </select>
            </div>
        {/if}
    </SettingsGroup>

    <SettingsGroup label={m.settings_playback_group_episodes()}>
        {@render toggleRow(
            'autoplay',
            m.settings_playback_autoplay(),
            '',
            playbackPreferences.autoplayNextEpisode,
            () => {
                updatePreference('autoplayNextEpisode', !playbackPreferences.autoplayNextEpisode);
                flashSaved();
            },
        )}
        {#if playbackPreferences.autoplayNextEpisode}
            <NumberPreference
                label={m.settings_playback_next_countdown()}
                min={3}
                max={60}
                value={playbackPreferences.nextEpisodeCountdownSeconds ??
                    playbackPreferences.nextEpisodeCountdownSecondsDefault}
                onchange={(value) => {
                    updatePreference('nextEpisodeCountdownSeconds', value);
                    flashSaved();
                }} />
            {@render toggleRow(
                '',
                m.settings_playback_still_watching(),
                m.settings_playback_still_watching_hint(),
                playbackPreferences.stillWatchingEnabled,
                () => {
                    updatePreference(
                        'stillWatchingEnabled',
                        !playbackPreferences.stillWatchingEnabled,
                    );
                    flashSaved();
                },
            )}
        {/if}
        {@render toggleRow(
            'skip-intro',
            m.settings_playback_skip_intro(),
            '',
            playbackPreferences.skipIntroAutomatically,
            () => {
                updatePreference(
                    'skipIntroAutomatically',
                    !playbackPreferences.skipIntroAutomatically,
                );
                flashSaved();
            },
        )}
        {@render toggleRow(
            'skip-credits',
            m.settings_playback_skip_credits(),
            '',
            playbackPreferences.skipCreditsAutomatically,
            () => {
                updatePreference(
                    'skipCreditsAutomatically',
                    !playbackPreferences.skipCreditsAutomatically,
                );
                flashSaved();
            },
        )}
    </SettingsGroup>

    <SettingsGroup label={m.settings_playback_group_next_popup()}>
        {@render toggleRow(
            'show-next-popup',
            m.settings_playback_show_next_popup(),
            m.settings_playback_show_next_popup_hint(),
            playbackPreferences.showNextEpisodePopup,
            () => {
                updatePreference('showNextEpisodePopup', !playbackPreferences.showNextEpisodePopup);
                flashSaved();
            },
        )}
        {#if playbackPreferences.showNextEpisodePopup}
            <NumberPreference
                label={m.settings_playback_popup_lead()}
                hint={m.settings_playback_popup_lead_hint()}
                min={-60}
                max={120}
                value={playbackPreferences.nextEpisodePromptLeadSeconds ??
                    $page.data?.player?.nextEpisodePromptLeadSeconds ??
                    0}
                onchange={(value) => {
                    updatePreference('nextEpisodePromptLeadSeconds', value);
                    flashSaved();
                }} />
            <NumberPreference
                label={m.settings_playback_no_outro_fallback()}
                hint={m.settings_playback_no_outro_fallback_hint()}
                min={0}
                max={120}
                value={playbackPreferences.noOutroFallbackSeconds ?? 30}
                onchange={(value) => {
                    updatePreference('noOutroFallbackSeconds', value);
                    flashSaved();
                }} />
            {@render toggleRow(
                '',
                m.settings_playback_auto_dismiss(),
                '',
                playbackPreferences.autoDismissNextEpisodePopup,
                () => {
                    updatePreference(
                        'autoDismissNextEpisodePopup',
                        !playbackPreferences.autoDismissNextEpisodePopup,
                    );
                    flashSaved();
                },
            )}
        {/if}
    </SettingsGroup>

    <SettingsGroup label={m.settings_playback_group_controls()}>
        <NumberPreference
            label={m.settings_playback_seek_step()}
            hint={m.settings_playback_seek_step_hint()}
            min={1}
            max={300}
            value={playbackPreferences.seekStepSeconds ??
                $page.data?.clientTuning?.playerSkipSeconds ??
                10}
            onchange={(value) => {
                updatePreference('seekStepSeconds', value);
                flashSaved();
            }} />
    </SettingsGroup>
</PreferenceSettingsGate>
