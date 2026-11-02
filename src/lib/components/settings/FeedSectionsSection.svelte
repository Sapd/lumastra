<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onDestroy, onMount, untrack } from 'svelte';
    import { Icon, LockClosed } from 'svelte-hero-icons';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import SettingsGroup from './SettingsGroup.svelte';
    import SavedCue from './SavedCue.svelte';
    import { createAutosave } from './autosave';
    import * as m from '$lib/paraglide/messages';
    import * as userApi from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import { SvelteSet } from 'svelte/reactivity';
    import {
        FEED_SECTION_KINDS,
        ESSENTIAL_FEED_KINDS,
        isSectionVisible,
        sanitizeHiddenKinds,
        type FeedMode,
    } from '$lib/shared/feed-section-kinds';

    interface Props {
        /** Current mode from server (defaults to 'full'). */
        feedMode?: FeedMode;
        /** Current hidden kinds from server. */
        hiddenSectionKinds?: string[];
        /** Kinds disabled by admin/feature flags (rendered locked, like admin-disabled widgets). */
        adminDisabledKinds?: string[];
    }
    let { feedMode = 'full', hiddenSectionKinds = [], adminDisabledKinds = [] }: Props = $props();

    const ESSENTIALS = new Set<string>(ESSENTIAL_FEED_KINDS);

    // Local editable state, seeded ONCE from props (this component owns the edit
    // buffer; untrack makes the seed-once intent explicit so later prop changes
    // don't clobber an in-progress edit). Seeded through sanitizeHiddenKinds so
    // stored legacy tokens (e.g. 'ai-suggestions', renamed to 'taste') resolve
    // to the canonical kind and the corresponding toggle renders hidden.
    let mode = $state<FeedMode>(untrack(() => feedMode));
    const hidden = new SvelteSet<string>(sanitizeHiddenKinds(untrack(() => hiddenSectionKinds)));

    const adminDisabled = $derived(new Set(adminDisabledKinds));

    /** Localised label for a section kind. */
    function kindLabel(kind: string): string {
        switch (kind) {
            case 'continue-watching':
                return m.settings_feed_kind_continue_watching();
            case 'fulfilled-requests':
                return m.settings_feed_kind_fulfilled_requests();
            case 'taste':
                return m.settings_feed_kind_taste();
            case 'mood-recommendations':
                return m.settings_feed_kind_mood_recommendations();
            case 'featured-pick':
                return m.settings_feed_kind_featured_pick();
            case 'because-you-watched':
                return m.settings_feed_kind_because_you_watched();
            case 'you-like':
                return m.settings_feed_kind_you_like();
            case 'explore-keywords':
                return m.settings_feed_kind_explore_keywords();
            case 'short-movies':
                return m.settings_feed_kind_short_movies();
            case 'anime':
                return m.settings_feed_kind_anime();
            case 'fresh-releases':
                return m.settings_feed_kind_fresh_releases();
            case 'binge-worthy':
                return m.settings_feed_kind_binge_worthy();
            case 'trending':
                return m.settings_feed_kind_trending();
            case 'popular-shows':
                return m.settings_feed_kind_popular_shows();
            case 'live-tv-whats-on-now':
                return m.settings_feed_kind_live_tv_whats_on_now();
            case 'recently-added':
                return m.settings_feed_kind_recently_added();
            case 'random-picks':
                return m.settings_feed_kind_random_picks();
            case 'music-quick-picks':
                return m.settings_feed_kind_music_quick_picks();
            case 'music-recently-played':
                return m.settings_feed_kind_music_recently_played();
            case 'music-because':
                return m.settings_feed_kind_music_because();
            case 'music-mood':
                return m.settings_feed_kind_music_mood();
            default:
                return kind;
        }
    }

    // Configurable (non-essential) kinds, in registry order.
    const configurableKinds = FEED_SECTION_KINDS.filter((k) => !ESSENTIALS.has(k));

    const MODE_OPTIONS: Array<{ value: FeedMode; label: () => string; desc: () => string }> = [
        {
            value: 'full',
            label: () => m.settings_feed_mode_full(),
            desc: () => m.settings_feed_mode_full_desc(),
        },
        {
            value: 'minimal',
            label: () => m.settings_feed_mode_minimal(),
            desc: () => m.settings_feed_mode_minimal_desc(),
        },
        {
            value: 'custom',
            label: () => m.settings_feed_mode_custom(),
            desc: () => m.settings_feed_mode_custom_desc(),
        },
    ];

    let activeDesc = $derived(MODE_OPTIONS.find((o) => o.value === mode)?.desc() ?? '');

    // The per-kind hide list only edits when in custom mode.
    let customEditable = $derived(mode === 'custom');

    /** Effective visibility of a kind under the CURRENT (unsaved) mode + hide set. */
    function effectiveVisible(kind: string): boolean {
        return isSectionVisible(kind, { mode, hiddenKinds: [...hidden] });
    }

    function toggle(kind: string): void {
        if (!customEditable) return;
        if (adminDisabled.has(kind)) return;
        if (hidden.has(kind)) hidden.delete(kind);
        else hidden.add(kind);
        scheduleSave();
    }

    function setMode(next: FeedMode): void {
        if (next === mode) return;
        mode = next;
        scheduleSave();
    }

    // Saves on its own like the rest of settings (it used to need its own
    // Save button). Same debounce + flush-on-leave as HomeWidgetsSection.
    let savedAt = $state(0);
    const autosave = createAutosave(save);
    const scheduleSave = autosave.schedule;

    // Leaving settings (component teardown) or closing the tab (pagehide) saves
    // a pending edit right away — behind any save already in flight.
    onDestroy(() => void autosave.flush());
    onMount(() => {
        const onPageHide = (): void => void autosave.flush();
        window.addEventListener('pagehide', onPageHide);
        return () => window.removeEventListener('pagehide', onPageHide);
    });

    async function save(): Promise<void> {
        // Sanitise locally too (drops unknown/essential) — the server re-sanitises.
        const hiddenKinds = sanitizeHiddenKinds([...hidden]);
        try {
            const { error } = await userApi.updateFeedPreferences({
                feedMode: mode,
                hiddenSectionKinds: hiddenKinds,
            });
            if (!error) {
                savedAt = Date.now();
            } else {
                toasts.error(m.settings_feed_save_error());
            }
        } catch {
            toasts.error(m.settings_feed_save_error());
        }
    }
</script>

<SettingsGroup label={m.settings_feed_section_title()} description={m.settings_feed_section_desc()}>
    {#snippet actions()}
        <SavedCue {savedAt} />
    {/snippet}
    <div class="px-4 py-3">
        <div
            role="radiogroup"
            aria-label={m.settings_feed_section_title()}
            class="flex flex-wrap gap-2">
            {#each MODE_OPTIONS as opt (opt.value)}
                <button
                    type="button"
                    role="radio"
                    aria-checked={mode === opt.value}
                    class="btn btn-sm"
                    class:variant-filled-primary={mode === opt.value}
                    class:variant-ghost-surface={mode !== opt.value}
                    onclick={() => setMode(opt.value)}>
                    {opt.label()}
                </button>
            {/each}
        </div>
        <p class="text-xs text-surface-400 mt-2">
            {activeDesc}
            {#if customEditable}{m.settings_feed_custom_hint()}{/if}
        </p>
    </div>

    {#each ESSENTIAL_FEED_KINDS as kind (kind)}
        <div class="flex items-center gap-3 py-2.5 px-4 text-surface-400">
            <Icon src={LockClosed} class="w-4 h-4 shrink-0" />
            <span class="flex-1 min-w-0 text-sm truncate">{kindLabel(kind)}</span>
            <span class="text-xs">{m.settings_feed_always_shown()}</span>
        </div>
    {/each}

    <!-- Per-kind switches, only editable under Custom -->
    {#each configurableKinds as kind (kind)}
        {@const locked = adminDisabled.has(kind)}
        {@const visible = effectiveVisible(kind)}
        <div class="flex items-center gap-3 py-2.5 px-4" class:opacity-60={!customEditable}>
            <span
                class="flex-1 min-w-0 text-sm truncate"
                class:text-surface-400={locked || !visible}>{kindLabel(kind)}</span>
            {#if locked}
                <span class="text-xs text-surface-500">{m.settings_home_admin_disabled()}</span>
            {:else}
                <div class="shrink-0">
                    <Toggle
                        label={m.settings_feed_toggle_label({ name: kindLabel(kind) })}
                        checked={visible}
                        disabled={!customEditable}
                        onchange={() => toggle(kind)} />
                </div>
            {/if}
        </div>
    {/each}
</SettingsGroup>
