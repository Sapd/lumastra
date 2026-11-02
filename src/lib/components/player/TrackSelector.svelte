<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    import { tick } from 'svelte';
    import PlayerIcon from './PlayerIcon.svelte';
    import { fitTrackMenu } from './track-menu-layout';
    import { playerStore } from './playerStore.svelte';
    import {
        normalizeLanguage,
        languagesMatch,
        formatAudioTrackLabel,
        trackLanguageName,
        audioTrackAccessibleName,
        subtitleTrackAccessibleName,
        distinctSubtitleChipLabels,
    } from './language-utils';
    import { localizedLanguageName, sortByLanguage } from '$lib/utils/language-codes';
    import { page } from '$app/stores';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import { resolvePromotableAudioLanguage, isTrackForced } from '$lib/shared/track-selection';
    import { isBurnInCodec } from './subtitle-utils';
    import { updatePreferences, playbackPreferences } from './preferences-sync.svelte';
    import SubtitleStyleSelector from './SubtitleStyleSelector.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import * as m from '$lib/paraglide/messages';
    import { resolve } from '$lib/paths';

    interface Props {
        onclose?: () => void;
        onwheel?: (event: WheelEvent) => void;
    }

    let { onclose, onwheel }: Props = $props();

    let showStylePanel = $state(false);
    let menuTrigger: HTMLButtonElement | null = null;

    function closeMenu(): void {
        onclose?.();
        menuTrigger?.focus();
    }
    let appearanceButton = $state<HTMLButtonElement>();
    let backButton = $state<HTMLButtonElement>();

    async function openAppearance(): Promise<void> {
        showStylePanel = true;
        await tick();
        backButton?.focus();
    }

    async function closeAppearance(): Promise<void> {
        showStylePanel = false;
        await tick();
        appearanceButton?.focus();
    }

    // Hide language codes and labels already carried by the primary line.
    function trackDetail(
        title: string | undefined,
        language: string | undefined,
        label: string,
    ): string {
        const detail = title?.trim() ?? '';
        if (!detail || detail.toLocaleLowerCase() === label.toLocaleLowerCase()) return '';
        if (normalizeLanguage(detail) === normalizeLanguage(language || label)) return '';
        return detail;
    }

    function selectAudioTrack(index: number) {
        playerStore.setAudioTrack(index);
    }

    // --- Why is this track playing? -------------------------------------------
    //
    // An automatic pick used to be completely silent, so a viewer whose Settings
    // default kept overriding them had no way to discover that — the only symptom
    // was re-selecting the same language on every episode. Name the preference
    // that chose, and offer the one-tap fix.

    const autoPickNote = $derived.by(() => {
        // localizedLanguageName, NOT iso639ToDisplayName: the latter reads an
        // English-only table of ~30 languages, so the German UI said "(Japanese)"
        // and anything outside the table rendered as a bare "(TA)".
        const language = localizedLanguageName(playerStore.audioSelectionLanguage, getLocale());
        switch (playerStore.audioSelectionReason) {
            case 'original-language':
                return m.player_audio_auto_original({ language });
            case 'original-language-untagged':
                return m.player_audio_auto_original_untagged({ language });
            case 'explicit-default':
                return m.player_audio_auto_default({ language });
            case 'explicit-default-untagged':
                return m.player_audio_auto_default_untagged({ language });
            case 'learned':
                return m.player_audio_auto_learned({ language });
            case 'no-match-file-default':
                // The viewer asked for something and this file has none of it.
                // Saying so is the whole point — silence here is what stranded
                // people on a third of the movie library.
                return m.player_audio_auto_no_match();
            default:
                // 'file-default' — no preference was expressed, nothing to explain.
                return null;
        }
    });

    /**
     * Language to offer as "make this my default", or null when the shortcut
     * would not take effect. All the reasoning lives in the resolver module.
     */
    const currentAudioTrack = $derived(
        playerStore.audioTracks.find((t) => t.index === playerStore.currentAudioTrackIndex),
    );

    const promotableLanguage = $derived(
        resolvePromotableAudioLanguage(currentAudioTrack, playbackPreferences),
    );

    /**
     * The language the confirmation refers to, or null while none is showing.
     * Compared against the track playing RIGHT NOW, not against the stored
     * preference: the stored one still equals what was just saved, so keying off
     * it would leave the confirmation latched and never offer the shortcut again
     * for a track the viewer switches to afterwards.
     */
    let savedLanguage = $state<string | null>(null);
    const savedAsDefault = $derived(
        savedLanguage !== null &&
            languagesMatch(
                currentAudioTrack?.language || currentAudioTrack?.languageCode,
                savedLanguage,
            ),
    );

    function setCurrentAudioAsDefault() {
        if (!promotableLanguage) return;
        updatePreferences({ audioLanguage: promotableLanguage });
        savedLanguage = promotableLanguage;
    }

    function selectSubtitleTrack(index: number | null) {
        if (index !== null && !playerStore.subtitleTracks.some((track) => track.index === index))
            return;
        playerStore.setSubtitleTrack(index);

        // Save subtitle preference to server (syncs via preferences-sync service).
        // The track hint disambiguates same-language tracks on restore
        // (e.g. English forced PGS vs English regular SRT).
        if (index !== null) {
            const track = playerStore.subtitleTracks.find((t) => t.index === index);
            if (track) {
                const normalizedLang = normalizeLanguage(track.language || track.languageCode);
                updatePreferences({
                    subtitleLanguage: normalizedLang,
                    subtitlesEnabled: true,
                    forcedSubtitlesEnabled: playerStore.forcedSubtitlesEnabled,
                    subtitleTrackHint: {
                        language: normalizedLang,
                        isForced: isTrackForced({
                            ...track,
                            title: track.title ?? track.displayTitle,
                        }),
                        codec: track.codec ?? null,
                        title: track.title ?? track.displayTitle,
                        ...(track.id && playerStore.currentMediaSource
                            ? {
                                  fileId: playerStore.currentMediaSource.id,
                                  trackId: track.id,
                              }
                            : {}),
                    },
                });
            }
        }
    }

    // Turn off all subtitles (including forced)
    function turnOffSubtitles() {
        playerStore.setSubtitleTrack(null);
        updatePreferences({
            subtitlesEnabled: false,
            subtitleLanguage: null,
            subtitleTrackHint: null,
        });
    }

    // Get short audio label
    function getAudioLabel(track: (typeof playerStore.audioTracks)[0]): {
        lang: string;
        channels: string;
    } {
        const lang =
            trackLanguageName(track.language || track.languageCode, getLocale()) ||
            formatAudioTrackLabel(track);
        let channels = '';
        if (track.channels >= 8) channels = '7.1';
        else if (track.channels >= 6) channels = '5.1';
        else if (track.channels === 2) channels = '2.0';
        else if (track.channels) channels = `${track.channels}ch`;
        return { lang, channels };
    }

    // Get short subtitle label
    function getSubtitleLabel(track: (typeof playerStore.subtitleTracks)[0]): string {
        return (
            trackLanguageName(track.language || track.languageCode, getLocale()) ||
            track.displayTitle ||
            'UNK'
        );
    }

    // Check if a subtitle is forced (either by flag or by name)
    function isForcedSubtitle(track: (typeof playerStore.subtitleTracks)[0]): boolean {
        if (track.isForced) return true;
        // Some files have "forced" in the display title but don't set IsForced flag
        const title = track.displayTitle?.toLowerCase() || '';
        return title.includes('forced');
    }

    // Check if a subtitle is SDH (Subtitles for the Deaf and Hard of Hearing)
    function isSdhSubtitle(track: (typeof playerStore.subtitleTracks)[0]): boolean {
        const title = track.displayTitle?.toUpperCase() || '';
        return title.includes('SDH');
    }

    // Check if a subtitle is CC (Closed Captions)
    function isCcSubtitle(track: (typeof playerStore.subtitleTracks)[0]): boolean {
        const title = track.displayTitle?.toUpperCase() || '';
        // Match "CC" but not as part of other words (e.g., "Acco" shouldn't match)
        return /\bCC\b/.test(title) || title.includes('CLOSED CAPTION');
    }

    // Check if a subtitle is Commentary
    function isCommentarySubtitle(track: (typeof playerStore.subtitleTracks)[0]): boolean {
        const title = track.displayTitle?.toUpperCase() || '';
        return title.includes('COMMENTARY');
    }

    // Check if a subtitle is Signs/Songs only
    function isSignsSubtitle(track: (typeof playerStore.subtitleTracks)[0]): boolean {
        const title = track.displayTitle?.toUpperCase() || '';
        return (
            title.includes('SIGNS') ||
            title.includes('SONGS') ||
            title.includes('SIGNS & SONGS') ||
            title.includes('SIGNS AND SONGS')
        );
    }

    const orderedAudioTracks = $derived(
        sortByLanguage(
            playerStore.audioTracks,
            (track) => track.language || track.languageCode,
            $page.data?.mediaLanguagePriority,
            playerStore.originalLanguage ?? undefined,
        ),
    );
    // Split subtitles into forced and non-forced (full subtitles)
    let hasForcedSubtitles = $derived(playerStore.subtitleTracks.some((t) => isForcedSubtitle(t)));
    let fullSubtitleTracks = $derived(
        sortByLanguage(
            playerStore.subtitleTracks.filter((t) => !isForcedSubtitle(t)),
            (track) => track.language || track.languageCode,
            $page.data?.mediaLanguagePriority,
            playerStore.originalLanguage ?? undefined,
        ),
    );

    const hasManySubtitles = $derived(fullSubtitleTracks.length > 10);
    let subtitleSearch = $state('');
    const filteredSubtitleTracks = $derived(
        fullSubtitleTracks.filter((track) =>
            [getSubtitleLabel(track), track.language, track.languageCode, track.displayTitle]
                .filter(Boolean)
                .join(' ')
                .toLocaleLowerCase()
                .includes(subtitleSearch.trim().toLocaleLowerCase()),
        ),
    );

    // One distinct label per chip (visible text AND accessible name). The
    // display title already carries the forced/SDH/CC qualifiers; tracks that
    // still read the same ("Deutsch", "Deutsch") get codec, then a number.
    let subtitleChipLabels = $derived(
        distinctSubtitleChipLabels(
            fullSubtitleTracks.map((t) => ({
                index: t.index,
                label: t.displayTitle || getSubtitleLabel(t),
                codecType: getSubtitleType(t),
            })),
        ),
    );

    // Check if a full (non-forced) subtitle is currently selected
    let isFullSubtitleSelected = $derived(
        (() => {
            if (playerStore.currentSubtitleTrackIndex == null) return false;
            const currentTrack = playerStore.subtitleTracks.find(
                (t) => t.index === playerStore.currentSubtitleTrackIndex,
            );
            return currentTrack && !isForcedSubtitle(currentTrack);
        })(),
    );

    // Whether the forced row should render at all
    let showForcedRow = $derived(hasForcedSubtitles || playerStore.forcedSubtitlesEnabled);

    // Forced row display state:
    // 'active'      — forced on, forced track is currently playing
    // 'dormant'     — forced on, but suppressed by a full subtitle selection
    // 'unavailable' — forced on, no forced tracks exist in this video
    // 'disabled'    — forced off globally
    type ForcedRowState = 'active' | 'dormant' | 'unavailable' | 'disabled';

    let forcedRowState = $derived(
        ((): ForcedRowState => {
            if (!playerStore.forcedSubtitlesEnabled) return 'disabled';
            if (!hasForcedSubtitles) return 'unavailable';
            const currentTrack =
                playerStore.currentSubtitleTrackIndex !== null
                    ? playerStore.subtitleTracks.find(
                          (t) => t.index === playerStore.currentSubtitleTrackIndex,
                      )
                    : null;
            // A full (non-forced) subtitle is active — forced is suppressed
            if (currentTrack && !isForcedSubtitle(currentTrack)) return 'dormant';
            // Forced is on and has tracks — report active regardless of whether a forced track
            // is currently playing. "Auto" without a language label covers the case where the
            // user pressed OFF (index is null) — honest: forced is ready but not playing right now.
            return 'active';
        })(),
    );

    // Language label shown only when a forced track is ACTUALLY playing (e.g. "ENG").
    // Not shown when nothing is playing — that would be dishonest about current playback state.
    let activeForcedLanguage = $derived(
        ((): string | null => {
            if (forcedRowState !== 'active') return null;
            const currentTrack =
                playerStore.currentSubtitleTrackIndex !== null
                    ? playerStore.subtitleTracks.find(
                          (t) => t.index === playerStore.currentSubtitleTrackIndex,
                      )
                    : null;
            if (currentTrack && isForcedSubtitle(currentTrack)) {
                return (
                    trackLanguageName(
                        currentTrack.language || currentTrack.languageCode,
                        getLocale(),
                    ) || null
                );
            }
            // Nothing is playing — don't claim a language
            return null;
        })(),
    );

    // Check if subtitle requires burn-in
    function needsBurnIn(track: (typeof playerStore.subtitleTracks)[0]): boolean {
        return track.deliveryMethod === 'Encode' || isBurnInCodec(track.codec);
    }

    // Check if subtitle is PGS (client-side rendered)
    function isPgsSubtitle(track: (typeof playerStore.subtitleTracks)[0]): boolean {
        const pgsCodecs = ['pgs', 'pgssub', 'hdmv_pgs_subtitle'];
        const codec = track.codec?.toLowerCase() || '';
        return pgsCodecs.some((c) => codec.includes(c));
    }

    // Get codec type display
    function getSubtitleType(track: (typeof playerStore.subtitleTracks)[0]): string | null {
        const codec = track.codec?.toLowerCase() || '';
        if (codec.includes('pgs') || codec.includes('hdmv_pgs')) return 'PGS';
        if (codec.includes('dvdsub') || codec.includes('vobsub')) return 'VOB';
        if (codec.includes('dvbsub')) return 'DVB';
        if (codec.includes('ass') || codec.includes('ssa')) return 'ASS';
        if (codec.includes('srt') || codec.includes('subrip')) return 'SRT';
        return null;
    }

    // Show codec badge on chip face only when needed to distinguish same-language
    // tracks that carry no context badge (SDH/CC/COM/S&S). When context badges
    // already disambiguate (e.g. ENG vs ENG SDH), codec stays tooltip-only.
    function needsCodecBadge(track: (typeof playerStore.subtitleTracks)[0]): boolean {
        if (!getSubtitleType(track)) return false; // no codec label to show
        const trackLang = normalizeLanguage(track.language || track.languageCode || '');
        if (!trackLang) return false;
        const hasContextBadge = (t: typeof track): boolean =>
            isSdhSubtitle(t) || isCcSubtitle(t) || isCommentarySubtitle(t) || isSignsSubtitle(t);
        // Find same-language non-forced tracks (the full subtitle pool)
        const peers = fullSubtitleTracks.filter(
            (t) => normalizeLanguage(t.language || t.languageCode || '') === trackLang,
        );
        if (peers.length < 2) return false;
        // Need codec badge if ≥2 peers lack any context badge (they'd be identical otherwise)
        const ambiguous = peers.filter((t) => !hasContextBadge(t));
        return ambiguous.length >= 2 && !hasContextBadge(track);
    }

    // Build enriched tooltip text for a subtitle track chip
    function getSubtitleTooltip(track: (typeof playerStore.subtitleTracks)[0]): string {
        const parts: string[] = [];
        if (track.displayTitle) parts.push(track.displayTitle);
        if (needsBurnIn(track)) {
            parts.push(m.player_subtitle_burnin_tooltip());
        } else if (isPgsSubtitle(track)) {
            parts.push(m.player_subtitle_pgs_tooltip());
        } else if (track.codec?.trim()) {
            parts.push(`Codec: ${track.codec.toUpperCase()}`);
        }
        if (track.deliveryMethod && track.deliveryMethod !== 'External') {
            parts.push(`Delivery: ${track.deliveryMethod}`);
        }
        // Spell out the context-badge jargon here on the single chip-level
        // tooltip. (Per-badge nested Tooltips were unreliable — nesting a tooltip
        // inside the chip's tooltip made the two race and cancel out.)
        if (isSdhSubtitle(track)) {
            parts.push(`${m.player_subtitle_sdh_label()} — ${m.player_subtitle_sdh_tooltip()}`);
        }
        if (isCcSubtitle(track)) {
            parts.push(`${m.player_subtitle_cc_label()} — ${m.player_subtitle_cc_tooltip()}`);
        }
        if (isCommentarySubtitle(track)) {
            parts.push(
                `${m.player_subtitle_com_label()} — ${m.player_subtitle_commentary_tooltip()}`,
            );
        }
        if (isSignsSubtitle(track)) {
            parts.push(`${m.player_subtitle_ss_label()} — ${m.player_subtitle_signs_tooltip()}`);
        }
        const result = parts.filter(Boolean).join(' · ');
        return result || getSubtitleLabel(track);
    }

    function handleKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            if (showStylePanel) {
                event.preventDefault();
                event.stopPropagation();
                void closeAppearance();
            } else {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
            }
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // Track and appearance widgets own keyboard input, including scrolling.
        event.stopPropagation();
    }

    function ownKeyboard(node: HTMLElement): { destroy: () => void } {
        menuTrigger =
            node
                .closest('.track-menu-container')
                ?.querySelector<HTMLButtonElement>('.control-button') ?? null;
        node.addEventListener('keydown', handleKeydown);
        return { destroy: () => node.removeEventListener('keydown', handleKeydown) };
    }

    // Handle wheel event (prevent propagation to player)
    function handleWheel(event: WheelEvent) {
        event.stopPropagation();
        onwheel?.(event);
    }
</script>

<div
    class="track-selector player-menu"
    use:fitTrackMenu
    use:ownKeyboard
    role="group"
    aria-label={m.player_track_selector_aria()}
    onwheel={handleWheel}>
    <div class="menu-header">
        {#if showStylePanel}
            <button
                class="back-button"
                bind:this={backButton}
                onclick={closeAppearance}
                aria-label={m.back()}>
                <span aria-hidden="true">←</span>
            </button>
        {/if}
        <h2 class="menu-title">
            {showStylePanel ? m.player_subtitle_settings() : m.player_audio_subtitle_tracks()}
        </h2>
        <button class="close-button" onclick={closeMenu} aria-label={m.close()}>
            <PlayerIcon name="close" size={18} />
        </button>
    </div>
    {#if hasManySubtitles && !showStylePanel}
        <input
            class="subtitle-search"
            type="search"
            aria-label={m.player_search_subtitles()}
            placeholder={m.player_search_subtitles()}
            bind:value={subtitleSearch} />
    {/if}
    <div class="track-content" hidden={showStylePanel}>
        <!-- Audio tracks -->
        {#if playerStore.audioTracks.length > 1}
            <div class="track-section audio-section">
                <h3 class="section-title">{m.player_audio_section_title()}</h3>
                <div class="track-grid">
                    {#each orderedAudioTracks as track (track.index)}
                        {@const label = getAudioLabel(track)}
                        <Tooltip text={track.displayTitle} position="top" fixed>
                            <button
                                class="track-chip"
                                class:selected={playerStore.currentAudioTrackIndex === track.index}
                                aria-label={audioTrackAccessibleName(
                                    trackDetail(
                                        track.displayTitle,
                                        track.language || track.languageCode,
                                        label.lang,
                                    )
                                        ? `${label.lang} — ${track.displayTitle}`
                                        : label.lang,
                                    label.channels,
                                )}
                                aria-pressed={playerStore.currentAudioTrackIndex === track.index}
                                onclick={() => selectAudioTrack(track.index)}>
                                <span class="track-copy">
                                    <span class="chip-lang">{label.lang}</span>
                                    {#if trackDetail(track.displayTitle, track.language || track.languageCode, label.lang)}
                                        <small>{track.displayTitle}</small>
                                    {/if}
                                </span>
                                {#if label.channels}
                                    <span class="chip-channels">{label.channels}</span>
                                {/if}
                                {#if playerStore.currentAudioTrackIndex === track.index}
                                    <span class="chip-check">✓</span>
                                {/if}
                            </button>
                        </Tooltip>
                    {/each}
                </div>
                {#if autoPickNote || promotableLanguage || savedAsDefault}
                    <div class="audio-note">
                        {#if autoPickNote}
                            <p class="audio-note-text">
                                {autoPickNote}
                                <a
                                    class="audio-note-hint"
                                    href={resolve('/settings/playback?highlight=audio-language')}
                                    >{m.player_audio_auto_change_in_settings()}</a>
                            </p>
                        {/if}
                        {#if savedAsDefault}
                            <p class="audio-note-saved">{m.player_audio_set_as_default_saved()}</p>
                        {:else if promotableLanguage}
                            <button class="audio-note-action" onclick={setCurrentAudioAsDefault}>
                                {m.player_audio_set_as_default()}
                            </button>
                        {/if}
                    </div>
                {/if}
            </div>
        {/if}

        <!-- Full subtitle tracks (non-forced only) -->
        {#if fullSubtitleTracks.length > 0}
            <div class="track-section subtitle-section">
                <h3 class="section-title">{m.player_full_subtitles()}</h3>
                <div class="track-grid subtitle-list">
                    <!-- Off option (no full subtitle - forced only or none) -->
                    <button
                        class="track-chip"
                        class:selected={!isFullSubtitleSelected}
                        aria-pressed={!isFullSubtitleSelected}
                        onclick={turnOffSubtitles}>
                        <span class="chip-lang">{m.player_subtitle_off()}</span>
                        {#if !isFullSubtitleSelected}
                            <span class="chip-check">✓</span>
                        {/if}
                    </button>

                    {#each filteredSubtitleTracks as track (track.index)}
                        {@const subType = getSubtitleType(track)}
                        {@const isBurnIn = needsBurnIn(track)}
                        {@const isPgs = isPgsSubtitle(track)}
                        {@const isSdh = isSdhSubtitle(track)}
                        {@const isCc = isCcSubtitle(track)}
                        {@const isCommentary = isCommentarySubtitle(track)}
                        {@const isSigns = isSignsSubtitle(track)}
                        {@const showCodec = needsCodecBadge(track)}
                        {@const tooltipText = getSubtitleTooltip(track)}
                        {@const chipLabel =
                            subtitleChipLabels.get(track.index) ??
                            (track.displayTitle || getSubtitleLabel(track))}
                        <Tooltip text={tooltipText} position="top" fixed>
                            <button
                                class="track-chip"
                                class:selected={playerStore.currentSubtitleTrackIndex ===
                                    track.index}
                                class:burn-in={isBurnIn}
                                class:pgs={isPgs}
                                aria-label={subtitleTrackAccessibleName(chipLabel)}
                                aria-pressed={playerStore.currentSubtitleTrackIndex === track.index}
                                onclick={() => selectSubtitleTrack(track.index)}>
                                <span class="track-copy">
                                    <span class="chip-lang">{getSubtitleLabel(track)}</span>
                                    {#if trackDetail(chipLabel, track.language || track.languageCode, getSubtitleLabel(track))}
                                        <small>{chipLabel}</small>
                                    {/if}
                                </span>
                                {#if subType && showCodec}
                                    <span
                                        class="chip-type"
                                        class:chip-type-burnin={isBurnIn}
                                        class:chip-type-pgs={isPgs}>{subType}</span>
                                {/if}
                                <!-- Context badges. Their meaning is carried by the
                                 single chip-level tooltip (getSubtitleTooltip) —
                                 a per-badge Tooltip nested inside the chip's own
                                 Tooltip made the two race and cancel out, so it
                                 rendered nothing. -->
                                {#if isSdh}
                                    <span class="chip-type chip-type-sdh"
                                        >{m.player_subtitle_sdh_label()}</span>
                                {/if}
                                {#if isCc}
                                    <span class="chip-type chip-type-cc"
                                        >{m.player_subtitle_cc_label()}</span>
                                {/if}
                                {#if isCommentary}
                                    <span class="chip-type chip-type-commentary"
                                        >{m.player_subtitle_com_label()}</span>
                                {/if}
                                {#if isSigns}
                                    <span class="chip-type chip-type-signs"
                                        >{m.player_subtitle_ss_label()}</span>
                                {/if}
                                {#if playerStore.currentSubtitleTrackIndex === track.index}
                                    <span class="chip-check">✓</span>
                                {/if}
                            </button>
                        </Tooltip>
                    {/each}
                </div>
                {#if filteredSubtitleTracks.length === 0}
                    <p class="no-subtitles" role="status">{m.player_no_matching_subtitles()}</p>
                {/if}
            </div>
        {/if}
        <!-- Forced subtitle row shares the track scroll area. -->
        {#if showForcedRow}
            <div class="track-section forced-row-section">
                <div class="forced-row">
                    <div class="forced-row-label">
                        {m.player_forced_subtitles()}
                        <Tooltip text={m.player_forced_subtitle_help()} position="top" fixed>
                            <span class="forced-help">?</span>
                        </Tooltip>
                    </div>
                    <div class="forced-row-right">
                        <span
                            class="forced-state-label"
                            class:forced-state-dormant={forcedRowState === 'dormant'}
                            class:forced-state-unavailable={forcedRowState === 'unavailable'}
                            class:forced-state-disabled={forcedRowState === 'disabled'}>
                            {#if forcedRowState === 'active'}
                                {m.player_auto()}{#if activeForcedLanguage}
                                    • {activeForcedLanguage}{/if}
                            {:else if forcedRowState === 'dormant'}
                                <Tooltip text={m.player_forced_dormant_hint()} position="top" fixed>
                                    <span>{m.player_auto()}</span>
                                </Tooltip>
                            {:else if forcedRowState === 'unavailable'}
                                <Tooltip
                                    text={m.player_forced_unavailable_hint()}
                                    position="top"
                                    fixed>
                                    <span>{m.player_auto()}</span>
                                </Tooltip>
                            {:else}
                                {m.player_forced_disabled()}
                            {/if}
                        </span>
                        <button
                            class="forced-toggle"
                            class:forced-toggle-on={playerStore.forcedSubtitlesEnabled}
                            aria-label={m.player_forced_subtitles()}
                            aria-pressed={playerStore.forcedSubtitlesEnabled}
                            onclick={() =>
                                playerStore.setForcedSubtitlesEnabled(
                                    !playerStore.forcedSubtitlesEnabled,
                                )}>
                            <span class="forced-toggle-knob"></span>
                        </button>
                    </div>
                </div>
            </div>
        {/if}
    </div>
    <div class="subtitle-settings" hidden={showStylePanel}>
        <!-- Appearance stays reachable outside the scrolling tracks. -->
        <div class="track-section">
            <button
                class="settings-expand-btn"
                bind:this={appearanceButton}
                onclick={openAppearance}>
                <svg class="settings-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path
                        fill-rule="evenodd"
                        d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
                        clip-rule="evenodd" />
                </svg>
                <span>{m.player_subtitle_settings()}</span>
                <svg class="chevron-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path
                        fill-rule="evenodd"
                        d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                        clip-rule="evenodd" />
                </svg>
            </button>
        </div>
    </div>
    {#if showStylePanel}
        <div class="style-panel-container">
            <SubtitleStyleSelector onclose={closeAppearance} />
            <p class="saved-default-note">{m.player_settings_reflect_defaults()}</p>
            <a class="all-settings-link" href={resolve('/settings/subtitles')}>
                {m.player_all_subtitle_settings()} →
            </a>
        </div>
    {/if}
</div>

<style>
    .menu-title {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        flex: 1;
        min-width: 0;
    }
    .track-copy {
        display: flex;
        flex: 1;
        min-width: 0;
        flex-direction: column;
        gap: 4px;
    }
    .track-copy small {
        color: #94a3b8;
        font-size: 10px;
        font-weight: 400;
        overflow-wrap: anywhere;
    }
    .track-selector {
        position: fixed;
        bottom: var(--track-menu-bottom, 80px);
        right: var(--track-menu-right, 24px);
        padding: 1rem;
        width: 380px;
        box-sizing: border-box;
        max-width: var(--track-menu-max-width, calc(100vw - 32px));
        max-height: var(--track-menu-max-height, min(640px, calc(100dvh - 104px)));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 100;
    }

    .menu-header,
    .subtitle-settings {
        flex-shrink: 0;
    }

    [hidden] {
        display: none !important;
    }

    .menu-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-bottom: 12px;
        border-bottom: 1px solid #ffffff12;
    }

    .back-button,
    .close-button {
        display: grid;
        place-items: center;
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: 6px;
        background: #ffffff0d;
        color: #cbd5e1;
        cursor: pointer;
    }

    .track-content {
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        padding: 8px 4px;
    }

    .subtitle-settings {
        border-top: 1px solid #ffffff12;
        padding-top: 8px;
    }

    .subtitle-search {
        flex-shrink: 0;
        width: 100%;
        margin: 12px 0 4px;
        padding: 0.65rem;
        border: 1px solid #ffffff26;
        border-radius: 6px;
        background: #ffffff0d;
        color: white;
        font-size: 12px;
    }

    .no-subtitles {
        color: #94a3b8;
        font-size: 12px;
        padding: 0.5rem;
    }

    .track-section {
        padding: 0.5rem 0;
    }

    .section-title {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #94a3b8;
        padding: 0 0.25rem 0.5rem;
        margin: 0;
    }

    /* Why the current audio track is playing, plus the one-tap fix. */
    .audio-note {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        padding: 0.5rem 0.25rem 0;
    }

    .audio-note-text {
        font-size: 10px;
        line-height: 1.4;
        color: rgba(255, 255, 255, 0.45);
        margin: 0;
    }

    .audio-note-hint {
        display: block;
        color: rgba(255, 255, 255, 0.3);
    }

    .audio-note-saved {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.55);
        margin: 0;
    }

    .audio-note-action {
        align-self: flex-start;
        padding: 0.3rem 0.55rem;
        font-size: 10px;
        font-weight: 600;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 0.25rem;
        color: rgba(255, 255, 255, 0.85);
        cursor: pointer;
        transition:
            background 0.15s ease,
            border-color 0.15s ease;
    }

    .audio-note-action:hover {
        background: rgba(255, 255, 255, 0.14);
        border-color: rgba(255, 255, 255, 0.25);
    }

    /* Short lists and mobile use a single column. */
    .track-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 0.35rem;
    }

    /* Make Tooltip wrappers stretch to fill grid cells */
    .track-grid > :global(*) {
        display: flex;
        width: 100%;
    }

    .track-chip {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        text-align: left;
        gap: 0.5rem;
        padding: 0.65rem 0.7rem;
        min-height: 44px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: white;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.15s ease;
        font-size: 11px;
        width: 100%;
    }

    .track-chip:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.2);
    }

    .track-chip.selected {
        background: rgba(129, 140, 248, 0.15);
        border-color: rgba(129, 140, 248, 0.5);
    }

    .chip-lang {
        font-weight: 600;
        font-size: 11px;
    }

    .chip-channels {
        font-size: 9px;
        color: rgba(255, 255, 255, 0.5);
    }

    .chip-type {
        font-size: 8px;
        padding: 0 3px;
        background: rgba(100, 100, 100, 0.4);
        color: rgba(255, 255, 255, 0.7);
        border-radius: 2px;
    }

    .chip-type-burnin {
        background: rgba(239, 68, 68, 0.3);
        color: #f87171;
    }

    .track-chip.burn-in {
        border-color: rgba(239, 68, 68, 0.3);
    }

    .track-chip.burn-in:hover {
        border-color: rgba(239, 68, 68, 0.5);
    }

    .track-chip.burn-in.selected {
        background: rgba(239, 68, 68, 0.15);
        border-color: rgba(239, 68, 68, 0.5);
    }

    /* PGS subtitles - green to indicate client-side rendering (no transcode) */
    .chip-type-pgs {
        background: rgba(34, 197, 94, 0.3);
        color: #4ade80;
    }

    .track-chip.pgs {
        border-color: rgba(34, 197, 94, 0.3);
    }

    .track-chip.pgs:hover {
        border-color: rgba(34, 197, 94, 0.5);
    }

    .track-chip.pgs.selected {
        background: rgba(34, 197, 94, 0.15);
        border-color: rgba(34, 197, 94, 0.5);
    }

    /* SDH subtitles - blue/cyan to distinguish from format badges */
    .chip-type-sdh {
        background: rgba(56, 189, 248, 0.3);
        color: #38bdf8;
        cursor: help;
    }

    /* CC (Closed Captions) - teal to distinguish from SDH */
    .chip-type-cc {
        background: rgba(20, 184, 166, 0.3);
        color: #14b8a6;
        cursor: help;
    }

    /* Commentary - yellow/amber for different purpose */
    .chip-type-commentary {
        background: rgba(251, 191, 36, 0.3);
        color: #fbbf24;
        cursor: help;
    }

    /* Signs & Songs - purple for specific purpose */
    .chip-type-signs {
        background: rgba(167, 139, 250, 0.3);
        color: #a78bfa;
        cursor: help;
    }

    .chip-check {
        flex-shrink: 0;
        font-size: 12px;
        color: #a5b4fc;
    }

    /* Scrollbar styling */
    .track-content::-webkit-scrollbar {
        width: 6px;
    }

    .track-content::-webkit-scrollbar-track {
        background: transparent;
    }

    .track-content::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 3px;
    }

    /* Settings expand button */
    .settings-expand-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.6rem 0.5rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        color: rgba(255, 255, 255, 0.8);
        font-size: 12px;
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .settings-expand-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.2);
    }

    .settings-icon {
        width: 16px;
        height: 16px;
        opacity: 0.7;
    }

    .chevron-icon {
        width: 16px;
        height: 16px;
        margin-left: auto;
        opacity: 0.5;
        transition: transform 0.2s ease;
    }

    .chevron-icon {
        transform: rotate(-90deg);
    }

    /* Style panel container */
    .style-panel-container {
        margin-top: 0.75rem;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        animation: slideDown 0.2s ease;
    }

    @keyframes slideDown {
        from {
            opacity: 0;
            transform: translateY(-10px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    /* Override SubtitleStyleSelector positioning when embedded */
    .style-panel-container :global(.style-selector) {
        position: relative;
        bottom: auto;
        right: auto;
        width: 100%;
        max-height: none;
        overflow: visible;
        box-shadow: none;
        border: 1px solid rgba(255, 255, 255, 0.1);
        /* Remove nested backdrop-filter for performance - parent already has blur */
        backdrop-filter: none;
    }

    /* Forced subtitle row */
    .forced-row-section {
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        padding-top: 0.5rem;
    }

    .forced-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.25rem 0.25rem;
        gap: 0.5rem;
    }

    .forced-row-label {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #94a3b8;
    }

    .forced-help {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 13px;
        height: 13px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.12);
        font-size: 8px;
        color: #94a3b8;
        cursor: help;
        font-weight: 700;
        text-transform: none;
        letter-spacing: 0;
    }

    .forced-row-right {
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }

    .forced-state-label {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.7);
    }

    .forced-state-dormant,
    .forced-state-unavailable {
        color: rgba(255, 255, 255, 0.35);
        font-style: italic;
        cursor: help;
    }

    .forced-state-disabled {
        color: rgba(255, 255, 255, 0.45);
    }

    /* Toggle pill */
    .forced-toggle {
        position: relative;
        width: 32px;
        height: 18px;
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 9px;
        cursor: pointer;
        transition:
            background 0.2s ease,
            border-color 0.2s ease;
        flex-shrink: 0;
    }

    .forced-toggle-on {
        background: rgba(129, 140, 248, 0.6);
        border-color: rgba(129, 140, 248, 0.8);
    }

    .forced-toggle-knob {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 12px;
        height: 12px;
        background: white;
        border-radius: 50%;
        transition: transform 0.2s ease;
    }

    .forced-toggle-on .forced-toggle-knob {
        transform: translateX(14px);
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
