<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    import {
        playerStore,
        DEFAULT_TRANSCODING_PROFILES,
        ORIGINAL_PROFILE,
        AUTO_PROFILE,
        AUDIO_ONLY_PROFILE,
    } from './playerStore.svelte';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';
    import type { TranscodingProfile } from '$lib/types/playback';
    import { getFriendlyResolution } from '$lib/utils/media-display';
    // Import from the canonical source (playback-display.ts) rather than
    // through playback-decision.ts to avoid an unnecessary indirection when
    // no decision logic is needed. (ref: DL-008)
    import { getPlayMethodLabel, getPlayMethodBadgeClass } from './playback-display';
    import { playbackPreferences, updatePreference } from './preferences-sync.svelte';
    import ToggleSwitch from './ToggleSwitch.svelte';
    import * as m from '$lib/paraglide/messages';
    import { resolve } from '$lib/paths';
    import {
        LIVE_TV_QUALITY_PROFILES,
        formatLiveTvDefaultQuality,
        formatLiveTvQualityStatus,
        liveTvChoiceForProfile,
    } from './livetv-quality.js';
    import { qualityOptionKey } from './quality-option-key.js';
    import { serverCapabilities } from '$lib/stores/server-capabilities.store.js';
    import type { LiveTvQualityChoice } from './livetv-quality-preference.js';
    interface Props {
        /** Whether auto quality mode is enabled (from config) */
        autoQualityEnabled?: boolean;
        /** Whether community annotation features are enabled */
        showAnnotations?: boolean;
        onclose?: () => void;
        onversionchange?: (fileId: string) => void;
        onlivequalitychange?: (choice: LiveTvQualityChoice) => Promise<boolean>;
    }

    let {
        autoQualityEnabled = true,
        showAnnotations = false,
        onclose,
        onversionchange,
        onlivequalitychange,
    }: Props = $props();

    // Playback settings section collapsed by default
    let showPlaybackSettings = $state(false);
    let liveQualitySwitching = $state(false);

    // Group profiles by resolution category
    interface QualityGroup {
        key: string;
        label: string;
        profiles: TranscodingProfile[];
    }

    function getQualityGroups(
        sourceHeight: number,
        isLiveStream: boolean,
        autoEnabled: boolean,
        inWatchParty: boolean,
        audioOnlyAvailable: boolean,
    ): QualityGroup[] {
        const groups: QualityGroup[] = [];

        // Smart Quality group (Auto + Original)
        // For LiveTV: disable Auto (adaptive bitrate doesn't work well with live streams)
        // If auto quality is disabled via config, only show Original
        const smartProfiles =
            isLiveStream || !autoEnabled ? [ORIGINAL_PROFILE] : [AUTO_PROFILE, ORIGINAL_PROFILE];
        groups.push({
            // Hide the "Smart" header when there's only Original (auto disabled)
            key: 'smart',
            label: smartProfiles.length > 1 ? m.player_quality_smart() : '',
            profiles: smartProfiles,
        });

        // Filter profiles to source height — VOD only.
        //
        // The live ladder is deliberately NOT filtered. There is no source height to
        // filter on: `playerStore.videoInfo` reads `currentMediaSource.videoStreams[0]`,
        // and the Live TV media source is built with `videoStreams: []`
        // (routes/watch/[itemId]/+page.server.ts) and never populated. `sourceHeight`'s
        // 1080 default is a placeholder, not a measurement.
        //
        // Do not "fix" this by feeding in a height from the HLS level — that is the
        // DELIVERED height, so on a stream already capped to 540p it would hide the
        // 720p and 1080p entries and strand the viewer below their own cap with no way
        // back up. Showing the full ladder is safe: the server clamps with
        // `scale=-2:'min(ih,H)'` and never upscales, and the adaptive path filters
        // against the real probe height server-side.
        const available = isLiveStream
            ? liveTvLadderEnabled
                ? LIVE_TV_QUALITY_PROFILES
                : []
            : DEFAULT_TRANSCODING_PROFILES.filter((p) => p.height <= sourceHeight);

        // Group by resolution
        const resolutions = [
            { key: '4k', label: m.player_quality_4k(), minHeight: 2160 },
            {
                key: '1080p',
                label: m.player_quality_1080p(),
                minHeight: 1080,
                maxHeight: 2159,
            },
            {
                key: '720p',
                label: m.player_quality_720p(),
                minHeight: 720,
                maxHeight: 1079,
            },
            {
                key: 'sd',
                label: m.player_quality_sd(),
                minHeight: 0,
                maxHeight: 719,
            },
        ];

        for (const res of resolutions) {
            const profiles = available.filter((p) => {
                if (res.maxHeight) {
                    return p.height >= res.minHeight && p.height <= res.maxHeight;
                }
                return p.height >= res.minHeight;
            });
            if (profiles.length > 0) {
                groups.push({ key: res.key, label: res.label, profiles });
            }
        }

        // Server-side gate: play_methods.audio_only.available is false when the
        // source has no audio stream at all — offering the rung then would let
        // the user pick it, only to hit an error toast and an immediate revert.
        if (!isLiveStream && !inWatchParty && audioOnlyAvailable) {
            groups.push({ key: 'audio', label: '', profiles: [AUDIO_ONLY_PROFILE] });
        }

        return groups;
    }

    function translateResolution(res: string): string {
        if (res === '4K') return m.player_quality_4k();
        if (res === '1080p') return m.player_quality_1080p();
        if (res === '720p') return m.player_quality_720p();
        if (res === '480p') return m.player_quality_sd();
        return res;
    }

    function getSourceLabel(): string {
        const range = playerStore.videoInfo?.videoRange || '';
        const isHdr = range.includes('HDR') || range.includes('Dolby Vision');
        const resolution = translateResolution(
            getFriendlyResolution(playerStore.videoInfo?.width, playerStore.videoInfo?.height),
        );

        // Append HDR suffix for high-res HDR content
        if (
            isHdr &&
            (resolution === m.player_quality_4k() || resolution === m.player_quality_1080p())
        ) {
            return `${resolution} HDR`;
        }
        return resolution || m.player_quality_sd();
    }

    async function selectQuality(profile: TranscodingProfile): Promise<void> {
        if (playerStore.isLive && onlivequalitychange) {
            const choice = liveTvChoiceForProfile(profile);
            // A live profile with no ladder id cannot be requested — bail rather than
            // sending the server a quality it will reject.
            if (!choice) return;
            await selectLiveChoice(choice);
            return;
        }
        playerStore.setQualityProfile(profile);
        onclose?.();
    }

    async function selectLiveChoice(choice: LiveTvQualityChoice): Promise<void> {
        if (!onlivequalitychange || liveQualitySwitching) return;
        if (playerStore.liveTvQuality?.selection === choice) return;
        liveQualitySwitching = true;
        try {
            const applied = await onlivequalitychange(choice);
            if (applied) onclose?.();
        } finally {
            liveQualitySwitching = false;
        }
    }

    function getBitrateLabel(profile: TranscodingProfile): string {
        const mbps = profile.maxBitrate / 1000000;
        return `${mbps} Mbps`;
    }

    function isCurrentQuality(profile: TranscodingProfile): boolean {
        if (playerStore.isLive && playerStore.liveTvQuality) {
            const choice = liveTvChoiceForProfile(profile);
            return choice !== null && playerStore.liveTvQuality.selection === choice;
        }
        const currentMode = playerStore.qualityMode;
        const current = playerStore.currentQualityProfile;

        // Check for Auto mode
        if (profile.mode === 'auto') {
            return currentMode === 'auto';
        }
        // Check for Original mode
        if (profile.mode === 'original') {
            return currentMode === 'original';
        }
        // Check for Audio-only mode
        if (profile.mode === 'audio-only') {
            return currentMode === 'audio-only';
        }
        // Fixed bitrate profile
        if (!current || current.mode === 'auto' || current.mode === 'original') {
            return false;
        }
        return profile.maxBitrate === current.maxBitrate;
    }

    function getPlayMethodBadge(): { text: string; class: string } {
        const method = playerStore.playMethod;
        return {
            text: getPlayMethodLabel(method),
            class: getPlayMethodBadgeClass(method),
        };
    }

    function formatBandwidth(bps: number | null): string {
        if (!bps) return m.player_quality_measuring();
        const mbps = bps / 1000000;
        return `${mbps.toFixed(1)} Mbps`;
    }

    // Version selection
    function selectVersion(variantId: string) {
        onversionchange?.(variantId);
    }

    function formatFileSize(bytes: number): string {
        if (bytes === 0) return '';
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1) return `${gb.toFixed(1)} GB`;
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(0)} MB`;
    }

    function getVariantInfo(v: import('$lib/types/playback').PlaybackVariant): {
        resolution: string;
        hdr: string;
        codec: string;
        audio: string;
        size: string;
    } {
        let resolution = '';
        if (v.videoWidth && v.videoHeight) {
            if (v.videoWidth >= 3840) resolution = m.player_quality_4k();
            else if (v.videoWidth >= 1920) resolution = m.player_quality_1080p();
            else if (v.videoWidth >= 1280) resolution = m.player_quality_720p();
            else resolution = `${v.videoHeight}p`;
        }

        const hdr = v.hdr && v.hdr !== 'sdr' ? v.hdr.toUpperCase() : '';
        const codec = v.videoCodec?.toUpperCase() || '';

        let audioInfo = '';
        if (v.audioCodec) {
            const ch = v.audioChannels ?? 0;
            const channels = ch >= 8 ? '7.1' : ch >= 6 ? '5.1' : ch > 2 ? `${ch}ch` : '';
            audioInfo = `${v.audioCodec.toUpperCase()}${channels ? ' ' + channels : ''}`;
        }

        return {
            resolution,
            hdr,
            codec,
            audio: audioInfo,
            size: v.fileSize ? formatFileSize(v.fileSize) : '',
        };
    }
    let liveTvPolicy = $derived($serverCapabilities.data?.liveTv);
    let liveTvLadderEnabled = $derived(liveTvPolicy?.adaptiveLadder.enabled === true);
    let liveTvSelection = $derived(playerStore.liveTvQuality?.selection ?? 'server');
    let qualityGroups = $derived(
        getQualityGroups(
            playerStore.videoInfo?.height || 1080,
            playerStore.isLive,
            autoQualityEnabled,
            watchTogether.isInWatchParty,
            playerStore.audioOnlyAvailable,
        ),
    );
    let playMethodBadge = $derived(getPlayMethodBadge());
    let measuredBandwidth = $derived(playerStore.measuredBandwidth);
    let adaptiveTarget = $derived(playerStore.adaptiveTargetBitrate);
    let liveTvQualityStatus = $derived(formatLiveTvQualityStatus(playerStore.liveTvQuality));
</script>

<div class="quality-selector player-menu" role="menu" aria-label={m.player_quality_aria()}>
    <!-- Header with source info -->
    <div class="header">
        <h3 class="title">{m.player_quality_title()}</h3>
        <div class="source-info">
            {#if playerStore.videoInfo}
                <span class="source-badge">{playerStore.videoInfo.codec?.toUpperCase()}</span>
                <span class="source-badge"
                    >{playerStore.videoInfo.width}x{playerStore.videoInfo.height}</span>
                {#if playerStore.videoInfo.videoRange !== 'SDR'}
                    <span class="source-badge hdr">{playerStore.videoInfo.videoRange}</span>
                {/if}
            {/if}
        </div>
    </div>

    <!-- Quality groups -->
    <div class="quality-groups">
        {#if playerStore.isLive && liveTvLadderEnabled}
            <div class="quality-group">
                <div class="group-header">{m.livetv_quality_group()}</div>
                <div class="group-options smart-group">
                    <button
                        class="quality-option smart-option"
                        disabled={liveQualitySwitching}
                        class:selected={liveTvSelection === 'server'}
                        onclick={() => selectLiveChoice('server')}>
                        <div class="option-content">
                            <span class="option-label">{m.livetv_quality_server_default()}</span>
                            <span class="option-sublabel"
                                >{m.livetv_quality_server_default_sublabel({
                                    quality: formatLiveTvDefaultQuality(
                                        liveTvPolicy?.adaptiveLadder.defaultQuality,
                                    ),
                                })}</span>
                        </div>
                        {#if liveTvSelection === 'server'}<span class="check-icon">✓</span>{/if}
                    </button>
                    <button
                        class="quality-option smart-option"
                        disabled={liveQualitySwitching}
                        class:selected={liveTvSelection === 'adaptive'}
                        onclick={() => selectLiveChoice('adaptive')}>
                        <div class="option-content">
                            <span class="option-label">{m.livetv_quality_adaptive()}</span>
                            <span class="option-sublabel"
                                >{m.livetv_quality_adaptive_sublabel()}</span>
                        </div>
                        {#if liveTvSelection === 'adaptive'}<span class="check-icon">✓</span>{/if}
                    </button>
                </div>
            </div>
        {/if}
        {#each qualityGroups as group, i (group.key || `group-${i}`)}
            <div class="quality-group">
                {#if group.label}
                    <div class="group-header">{group.label}</div>
                {/if}
                <div
                    class="group-options"
                    class:single={group.profiles.length === 1}
                    class:smart-group={group.key === 'smart'}>
                    {#each group.profiles as profile (qualityOptionKey(profile))}
                        {#if profile.mode === 'auto'}
                            <!-- Auto (adaptive) option -->
                            <button
                                class="quality-option smart-option"
                                disabled={liveQualitySwitching}
                                class:selected={isCurrentQuality(profile)}
                                onclick={() => selectQuality(profile)}>
                                <div class="option-content">
                                    <span class="option-label"
                                        >{m.player_quality_auto_label()}</span>
                                    <span class="option-sublabel">
                                        {#if adaptiveTarget && adaptiveTarget > 0}
                                            {formatBandwidth(adaptiveTarget)}
                                        {:else if measuredBandwidth}
                                            {m.player_quality_measuring()}
                                        {:else}
                                            {m.player_quality_adapts()}
                                        {/if}
                                    </span>
                                </div>
                                {#if isCurrentQuality(profile)}
                                    <span class="method-badge {playMethodBadge.class}"
                                        >{playMethodBadge.text}</span>
                                    <span class="check-icon">
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            width="16"
                                            height="16">
                                            <path
                                                d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                        </svg>
                                    </span>
                                {/if}
                            </button>
                        {:else if profile.mode === 'original'}
                            <!-- Original (highest quality) option -->
                            <button
                                class="quality-option smart-option"
                                disabled={liveQualitySwitching}
                                class:selected={isCurrentQuality(profile)}
                                onclick={() => selectQuality(profile)}>
                                <div class="option-content">
                                    <span class="option-label"
                                        >{m.player_quality_original_label()}</span>
                                    <span class="option-sublabel">{getSourceLabel()}</span>
                                </div>
                                {#if isCurrentQuality(profile)}
                                    <span class="method-badge {playMethodBadge.class}"
                                        >{playMethodBadge.text}</span>
                                    <span class="check-icon">
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            width="16"
                                            height="16">
                                            <path
                                                d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                        </svg>
                                    </span>
                                {/if}
                            </button>
                        {:else if profile.mode === 'audio-only'}
                            <!-- Audio-only option -->
                            <button
                                class="quality-option smart-option"
                                disabled={liveQualitySwitching}
                                class:selected={isCurrentQuality(profile)}
                                onclick={() => selectQuality(profile)}>
                                <div class="option-content">
                                    <span class="option-label"
                                        >{m.player_quality_audio_only_label()}</span>
                                    <span class="option-sublabel"
                                        >{m.player_quality_audio_only_sublabel()}</span>
                                </div>
                                {#if isCurrentQuality(profile)}
                                    <span class="method-badge {playMethodBadge.class}"
                                        >{playMethodBadge.text}</span>
                                    <span class="check-icon">
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            width="16"
                                            height="16">
                                            <path
                                                d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                        </svg>
                                    </span>
                                {/if}
                            </button>
                        {:else}
                            <!-- Regular quality option -->
                            <button
                                class="quality-option"
                                disabled={liveQualitySwitching}
                                class:selected={isCurrentQuality(profile)}
                                onclick={() => selectQuality(profile)}>
                                <span class="option-bitrate">{getBitrateLabel(profile)}</span>
                                {#if isCurrentQuality(profile)}
                                    <span class="check-icon">
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            width="14"
                                            height="14">
                                            <path
                                                d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                        </svg>
                                    </span>
                                {/if}
                            </button>
                        {/if}
                    {/each}
                </div>
            </div>
        {/each}
    </div>

    <!-- Current status footer -->
    <div class="footer">
        <span class="footer-label">{m.player_quality_current_label()}</span>
        <span class="footer-value">
            {#if playerStore.isLive && liveTvQualityStatus}
                {liveTvQualityStatus}
            {:else if playerStore.qualityMode === 'auto'}
                {m.player_quality_auto_label()}{#if adaptiveTarget && adaptiveTarget > 0}
                    ({formatBandwidth(adaptiveTarget)}){/if}
            {:else if playerStore.qualityMode === 'original'}
                {m.player_quality_original_label()} ({playMethodBadge.text})
            {:else if playerStore.currentQualityProfile}
                {playerStore.currentQualityProfile.label} ({playMethodBadge.text})
            {:else}
                {m.player_quality_original_label()} ({playMethodBadge.text})
            {/if}
        </span>
    </div>

    <!-- Bandwidth info (when in auto mode) -->
    {#if playerStore.qualityMode === 'auto' && measuredBandwidth}
        <div class="bandwidth-info">
            <span class="bandwidth-label">{m.player_quality_connection_label()}</span>
            <span class="bandwidth-value">{formatBandwidth(measuredBandwidth)}</span>
        </div>
    {/if}

    <!-- Version/Source selection (for multi-version movies) -->
    {#if playerStore.playbackVariants.length > 1}
        <div class="version-section">
            <div class="version-header">
                {m.player_quality_version_header()}
            </div>
            <div class="version-grid">
                {#each playerStore.playbackVariants as variant (variant.id)}
                    {@const info = getVariantInfo(variant)}
                    <button
                        class="version-card"
                        class:selected={playerStore.activeVariantId === variant.id}
                        onclick={() => selectVersion(variant.id)}>
                        {#if variant.label && variant.label !== 'Default' && variant.label !== 'Lumastra'}
                            <div class="version-label">{variant.label}</div>
                        {/if}
                        <div class="version-main">
                            <span class="version-res">{info.resolution}</span>
                            {#if info.hdr}
                                <span class="version-hdr">{info.hdr}</span>
                            {/if}
                        </div>
                        <div class="version-meta">
                            <span>{info.codec}</span>
                            {#if info.audio}
                                <span>·</span>
                                <span>{info.audio}</span>
                            {/if}
                        </div>
                        {#if info.size}
                            <div class="version-size">{info.size}</div>
                        {/if}
                        {#if playerStore.activeVariantId === variant.id}
                            <span class="check-badge">✓</span>
                        {/if}
                    </button>
                {/each}
            </div>
        </div>
    {/if}

    <!-- Playback Settings (collapsible) -->
    <div class="playback-settings-section">
        <button
            class="settings-toggle"
            onclick={() => (showPlaybackSettings = !showPlaybackSettings)}
            aria-expanded={showPlaybackSettings}>
            <span class="settings-toggle-text">{m.player_playback_settings()}</span>
            <span class="settings-toggle-arrow" class:expanded={showPlaybackSettings}>›</span>
        </button>

        {#if showPlaybackSettings}
            <div class="settings-content">
                <!-- Auto-play next episode toggle -->
                <div class="setting-toggle">
                    <div class="setting-toggle-label">
                        <span class="setting-toggle-title">{m.player_autoplay_next()}</span>
                        <span class="setting-toggle-desc">{m.player_autoplay_next_desc()}</span>
                    </div>
                    <ToggleSwitch
                        active={playbackPreferences.autoplayNextEpisode}
                        ariaLabel={m.player_autoplay_next()}
                        onclick={() =>
                            updatePreference(
                                'autoplayNextEpisode',
                                !playbackPreferences.autoplayNextEpisode,
                            )} />
                </div>

                <!-- Countdown duration (only visible when autoplay is on) -->
                {#if playbackPreferences.autoplayNextEpisode}
                    <div class="setting-toggle">
                        <div class="setting-toggle-label">
                            <span class="setting-toggle-title"
                                >{m.player_quality_countdown_title()}</span>
                            <span class="setting-toggle-desc"
                                >{m.player_quality_countdown_desc()}</span>
                        </div>
                        <div class="countdown-input-wrap">
                            <input
                                type="number"
                                min="3"
                                max="60"
                                value={playbackPreferences.nextEpisodeCountdownSeconds ??
                                    playbackPreferences.nextEpisodeCountdownSecondsDefault}
                                placeholder={String(
                                    playbackPreferences.nextEpisodeCountdownSecondsDefault,
                                )}
                                class="countdown-input"
                                onchange={(e) => {
                                    const v = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(v) && v >= 3 && v <= 60) {
                                        updatePreference('nextEpisodeCountdownSeconds', v);
                                    }
                                }} />
                            <span class="countdown-unit">s</span>
                        </div>
                    </div>
                {/if}

                <!-- Auto-skip intro toggle -->
                <div class="setting-toggle">
                    <div class="setting-toggle-label">
                        <span class="setting-toggle-title">{m.player_skip_intro()}</span>
                        <span class="setting-toggle-desc">{m.player_skip_intro_desc()}</span>
                    </div>
                    <ToggleSwitch
                        active={playbackPreferences.skipIntroAutomatically}
                        ariaLabel={m.player_skip_intro()}
                        onclick={() =>
                            updatePreference(
                                'skipIntroAutomatically',
                                !playbackPreferences.skipIntroAutomatically,
                            )} />
                </div>

                <!-- Auto-skip credits toggle -->
                <div class="setting-toggle">
                    <div class="setting-toggle-label">
                        <span class="setting-toggle-title">{m.player_skip_credits()}</span>
                        <span class="setting-toggle-desc">{m.player_skip_credits_desc()}</span>
                    </div>
                    <ToggleSwitch
                        active={playbackPreferences.skipCreditsAutomatically}
                        ariaLabel={m.player_skip_credits()}
                        onclick={() =>
                            updatePreference(
                                'skipCreditsAutomatically',
                                !playbackPreferences.skipCreditsAutomatically,
                            )} />
                </div>

                <!-- Inbound reassurance: these reflect saved defaults (spec). -->
                <p class="saved-default-note">{m.player_settings_reflect_defaults()}</p>

                <!-- Outbound deep-link to the full Settings surface (spec). Uses a
                     plain <a> so it navigates WITHOUT calling onclose() — the
                     player keeps playing underneath the /settings overlay. -->
                <a class="all-settings-link" href={resolve('/settings/playback')}>
                    {m.player_all_playback_settings()} →
                </a>
            </div>
        {/if}
    </div>

    <!-- Community Settings (only when mediaAnnotations feature is on) -->
    {#if showAnnotations}
        <div class="playback-settings-section">
            <div class="settings-section-heading">
                {m.player_quality_community_heading()}
            </div>
            <div class="settings-content">
                <!-- Show pin markers on seekbar -->
                <div class="setting-toggle">
                    <div class="setting-toggle-label">
                        <span class="setting-toggle-title"
                            >{m.player_quality_seekbar_pins_title()}</span>
                        <span class="setting-toggle-desc"
                            >{m.player_quality_seekbar_pins_desc()}</span>
                    </div>
                    <ToggleSwitch
                        active={playbackPreferences.showAnnotationMarkers}
                        ariaLabel={m.player_quality_seekbar_pins_aria()}
                        onclick={() =>
                            updatePreference(
                                'showAnnotationMarkers',
                                !playbackPreferences.showAnnotationMarkers,
                            )} />
                </div>

                <!-- Auto-pop annotation overlay -->
                <div class="setting-toggle">
                    <div class="setting-toggle-label">
                        <span class="setting-toggle-title"
                            >{m.player_quality_auto_show_pins_title()}</span>
                        <span class="setting-toggle-desc"
                            >{m.player_quality_auto_show_pins_desc()}</span>
                    </div>
                    <ToggleSwitch
                        active={playbackPreferences.autoShowAnnotations}
                        ariaLabel={m.player_quality_auto_show_pins_aria()}
                        onclick={() =>
                            updatePreference(
                                'autoShowAnnotations',
                                !playbackPreferences.autoShowAnnotations,
                            )} />
                </div>
            </div>
        </div>
    {/if}
</div>

<style>
    .quality-selector {
        position: fixed;
        bottom: 80px;
        right: 20px;
        padding: 1rem;
        width: 340px;
        max-width: calc(100vw - 32px);
        max-height: calc(100dvh - 100px);
        overflow-y: auto;
        z-index: 100;
    }

    .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        margin-bottom: 0.5rem;
    }

    .title {
        font-size: 14px;
        font-weight: 600;
        color: white;
        margin: 0;
    }

    .source-info {
        display: flex;
        gap: 0.35rem;
    }

    .source-badge {
        font-size: 9px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.7);
        text-transform: uppercase;
    }

    .source-badge.hdr {
        background: rgba(147, 51, 234, 0.3);
        color: #c084fc;
    }

    .quality-groups {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .quality-group {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .group-header {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #94a3b8;
        padding: 0.25rem 0;
    }

    .group-options {
        display: grid !important;
        grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
        gap: 0.35rem;
    }

    .group-options.single {
        grid-template-columns: 1fr !important;
    }

    .group-options.smart-group {
        grid-template-columns: repeat(2, 1fr) !important;
    }

    .quality-option {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0.5rem 0.5rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: white;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.15s ease;
        font-size: 12px;
        font-weight: 500;
    }

    .quality-option:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.2);
    }

    .quality-option:disabled {
        cursor: wait;
        opacity: 0.55;
    }

    .quality-option.selected {
        background: rgba(129, 140, 248, 0.15);
        border-color: rgba(129, 140, 248, 0.5);
    }

    .quality-option.smart-option {
        justify-content: flex-start;
        padding: 0.6rem 0.75rem;
        gap: 0.5rem;
    }

    .option-content {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        flex: 1;
    }

    .option-label {
        font-weight: 600;
        font-size: 13px;
    }

    .option-sublabel {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.5);
    }

    .option-bitrate {
        font-size: 11px;
        white-space: nowrap;
    }

    .method-badge {
        font-size: 9px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 3px;
        text-transform: uppercase;
    }

    .badge-direct {
        background: rgba(34, 197, 94, 0.2);
        color: #4ade80;
    }

    .badge-remux {
        background: rgba(59, 130, 246, 0.2);
        color: #60a5fa;
    }

    .badge-transcode {
        background: rgba(245, 158, 11, 0.2);
        color: #fbbf24;
    }

    .check-icon {
        position: absolute;
        top: 4px;
        right: 4px;
        color: #a5b4fc;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .smart-option .check-icon {
        position: static;
    }

    .footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-top: 0.5rem;
        margin-top: 0.5rem;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        font-size: 11px;
    }

    .footer-label {
        color: #94a3b8;
    }

    .footer-value {
        color: rgba(255, 255, 255, 0.8);
        font-weight: 500;
    }

    .bandwidth-info {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-top: 0.35rem;
        font-size: 10px;
    }

    .bandwidth-label {
        color: rgba(255, 255, 255, 0.3);
    }

    .bandwidth-value {
        color: rgba(59, 130, 246, 0.8);
        font-weight: 500;
    }

    /* Version section */
    .version-section {
        padding-top: 0.5rem;
        margin-top: 0.5rem;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
    }

    .version-header {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #94a3b8;
        padding: 0.25rem 0;
    }

    .version-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 0.5rem;
    }

    .version-card {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        padding: 0.6rem 0.75rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: white;
        cursor: pointer;
        border-radius: 8px;
        transition: all 0.15s ease;
        text-align: left;
    }

    .version-card:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.2);
    }

    .version-card.selected {
        background: rgba(129, 140, 248, 0.15);
        border-color: rgba(129, 140, 248, 0.5);
    }

    .version-label {
        font-size: 11px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.7);
        margin-bottom: 0.15rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .version-main {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin-bottom: 0.25rem;
    }

    .version-res {
        font-size: 14px;
        font-weight: 600;
    }

    .version-hdr {
        font-size: 9px;
        font-weight: 600;
        padding: 1px 4px;
        border-radius: 3px;
        background: rgba(147, 51, 234, 0.3);
        color: #c084fc;
    }

    .version-meta {
        display: flex;
        gap: 0.3rem;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.5);
    }

    .version-size {
        font-size: 9px;
        color: #94a3b8;
        margin-top: 0.2rem;
    }

    .check-badge {
        position: absolute;
        top: 4px;
        right: 6px;
        font-size: 12px;
        color: #a5b4fc;
    }

    /* Mobile: 2 columns */
    @media (max-width: 400px) {
        .quality-selector {
            min-width: 280px;
        }

        .group-options {
            grid-template-columns: repeat(2, 1fr);
        }

        .group-options.smart-group {
            grid-template-columns: 1fr !important;
        }

        .version-grid {
            grid-template-columns: 1fr;
        }
    }

    /* Mobile portrait - position above controls, make scrollable */
    @media (max-width: 640px) and (orientation: portrait) {
        .quality-selector {
            position: fixed;
            bottom: auto;
            top: 50%;
            left: 50%;
            right: auto;
            transform: translate(-50%, -50%);
            width: calc(100vw - 32px);
            max-width: min(340px, calc(100vw - 32px));
            max-height: calc(100vh - 160px);
            overflow-y: auto;
        }
    }

    /* Playback settings section */
    .playback-settings-section {
        padding-top: 0.5rem;
        margin-top: 0.5rem;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
    }

    .settings-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: 0.4rem 0;
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.5);
        cursor: pointer;
        transition: color 0.15s ease;
    }

    .settings-toggle:hover {
        color: rgba(255, 255, 255, 0.7);
    }

    .settings-toggle-text {
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }

    .settings-toggle-arrow {
        font-size: 14px;
        font-weight: 600;
        transition: transform 0.2s ease;
    }

    .settings-toggle-arrow.expanded {
        transform: rotate(90deg);
    }

    .settings-content {
        padding-top: 0.25rem;
    }

    /* Settings toggles */
    .setting-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.5rem 0.25rem;
    }

    .setting-toggle:not(:last-child) {
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .setting-toggle-label {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
    }

    .setting-toggle-title {
        font-size: 12px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.9);
    }

    .setting-toggle-desc {
        font-size: 10px;
        color: #94a3b8;
        font-weight: 400;
    }

    .settings-section-heading {
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(255, 255, 255, 0.5);
        padding: 0.4rem 0;
    }

    .countdown-input-wrap {
        display: flex;
        align-items: center;
        gap: 0.25rem;
    }

    .countdown-input {
        width: 52px;
        padding: 0.25rem 0.4rem;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 4px;
        color: white;
        font-size: 12px;
        font-weight: 500;
        text-align: center;
        appearance: textfield;
    }

    .countdown-input::-webkit-inner-spin-button,
    .countdown-input::-webkit-outer-spin-button {
        opacity: 1;
    }

    .countdown-input:focus {
        outline: none;
        border-color: rgba(129, 140, 248, 0.5);
        background: rgba(255, 255, 255, 0.12);
    }

    .countdown-unit {
        font-size: 11px;
        color: #94a3b8;
    }

    .all-settings-link {
        display: block;
        width: 100%;
        text-align: center;
        padding: 0.6rem;
        margin-top: 0.5rem;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.06);
        color: rgba(255, 255, 255, 0.85);
        font-size: 12px;
        font-weight: 500;
    }
    .all-settings-link:hover {
        background: rgba(255, 255, 255, 0.12);
    }
    .saved-default-note {
        font-size: 10px;
        color: #94a3b8;
        padding: 0.4rem 0 0.1rem;
    }
</style>
