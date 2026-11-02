<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { page } from '$app/stores';
    import {
        Icon,
        ViewColumns,
        InformationCircle,
        Language,
        EyeSlash,
        UserGroup,
        MagnifyingGlass,
        Film,
        PlayCircle,
        ArrowUturnLeft,
        Swatch,
        Bell,
        type IconSource,
    } from 'svelte-hero-icons';
    import {
        playbackPreferences,
        updatePreference,
    } from '$lib/components/player/preferences-sync.svelte';
    import PreferenceSettingsGate from './PreferenceSettingsGate.svelte';
    import { uiPreferences } from '$lib/stores/uiPreferences';
    import { dockVisible, toggleDockHidden } from '$lib/stores/dock.store';
    import * as userApi from '$lib/api/user';
    import { getActiveDampers, clearDamper, clearAllDampers } from '$lib/api/for-you';
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import { toasts } from '$lib/stores/toast.store';
    import type { TasteDamperItem } from '$lib/schemas/api-for-you-responses';
    import { getLocale, setLocale, locales, isLocale } from '$lib/paraglide/runtime.js';
    import * as m from '$lib/paraglide/messages';
    import { THEME_COOKIE, DEFAULT_THEME_ID } from '$lib/shared/theme/theme-model';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import SettingsGroup from './SettingsGroup.svelte';
    import NotificationWebhookPanel from './NotificationWebhookPanel.svelte';
    import NotificationForwardingPanel from './NotificationForwardingPanel.svelte';
    import {
        desktopNotifications,
        enable as enableDesktopNotifications,
        disable as disableDesktopNotifications,
        init as initDesktopNotificationsState,
        refreshPermission as refreshDesktopNotificationsPermission,
    } from '$lib/notifications-desktop.js';

    interface Props {
        /**
         * Metadata language options from the route-scoped SSR loader
         * (src/routes/settings/display/+page.server.ts): `primary` mirrors
         * config.TMDB_LANGUAGE (bare language code), `additional` mirrors
         * config.METADATA_ADDITIONAL_LANGUAGES. Empty `additional` = feature
         * off = both pickers hidden.
         */
        metadataLanguages?: { primary: string; additional: string[] };
    }

    let { metadataLanguages }: Props = $props();

    const showDockToggle = $derived($page.data?.features?.dockToggle !== false);

    // Poster hover previews need a pointer that can hover; on a phone or tablet
    // the switch did nothing, so it is hidden there.
    let canHover = $state(true);
    onMount(() => {
        const mq = window.matchMedia('(hover: hover)');
        canHover = mq.matches;
        const onChange = (e: MediaQueryListEvent): void => {
            canHover = e.matches;
        };
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    });

    const localeNames: Record<string, string> = { en: 'English', de: 'Deutsch' };
    let currentLocale = $state(getLocale());

    function handleLocaleChange(event: Event): void {
        const value = (event.currentTarget as HTMLSelectElement).value;
        if (isLocale(value) && value !== currentLocale) {
            currentLocale = value;
            setLocale(value); // writes cookie + reloads
        }
    }

    // Theme picker — mirrors the locale switcher's UX (select + onchange), but
    // unlike locale this is a live, no-reload swap: root layout load already
    // resolved `page.data.themes` server-side (cookie → admin default) and the
    // per-theme CSS custom-property overrides for every enabled theme are
    // always present in <head> (see hooks.server.ts), so flipping the
    // `data-theme` attribute is enough to repaint instantly.
    interface ThemesPageData {
        enabled: { id: string; name: string }[];
        active: string;
    }

    const enabledThemes = $derived(
        ($page.data?.themes as ThemesPageData | undefined)?.enabled ?? [],
    );
    // Seeded once from the SSR-resolved active theme, then owned locally — the
    // same "capture initial value, then self-manage" pattern as currentLocale
    // above, since a local swap has no server round-trip to re-sync from.
    let currentTheme = $state(
        ($page.data?.themes as ThemesPageData | undefined)?.active ?? DEFAULT_THEME_ID,
    );

    function handleThemeChange(event: Event): void {
        const value = (event.currentTarget as HTMLSelectElement).value;
        const isEnabled = enabledThemes.some((theme) => theme.id === value);
        if (!isEnabled || value === currentTheme) return;
        currentTheme = value;
        // Non-httpOnly prefs cookie, written the same way paraglide's setLocale
        // writes PARAGLIDE_LOCALE — but no reload: swap data-theme directly.
        document.cookie = `${THEME_COOKIE}=${value}; path=/; max-age=31536000; SameSite=Lax`;
        document.documentElement.setAttribute('data-theme', value);
    }

    // Metadata (descriptions/titles) language pickers — only shown when the
    // admin has configured additional metadata languages (feature off = empty
    // list = zero UI noise).
    const metadataLangPrimary = $derived(metadataLanguages?.primary);
    const metadataLangAdditional = $derived(metadataLanguages?.additional ?? []);
    const showMetadataLanguagePickers = $derived(metadataLangAdditional.length > 0);

    function languageOptionLabel(tag: string): string {
        try {
            const displayNames = new Intl.DisplayNames([currentLocale], { type: 'language' });
            const name = displayNames.of(tag);
            return name && name !== tag ? `${name} (${tag})` : tag;
        } catch {
            return tag;
        }
    }

    const metadataLanguageOptions = $derived.by(() => {
        const options: { value: string; label: string }[] = [
            { value: '', label: m.settings_metadata_lang_follow_app() },
        ];
        const seen = new SvelteSet<string>();
        if (metadataLangPrimary && !seen.has(metadataLangPrimary)) {
            seen.add(metadataLangPrimary);
            options.push({
                value: metadataLangPrimary,
                label: languageOptionLabel(metadataLangPrimary),
            });
        }
        for (const lang of metadataLangAdditional) {
            if (seen.has(lang)) continue;
            seen.add(lang);
            options.push({ value: lang, label: languageOptionLabel(lang) });
        }
        return options;
    });

    // Descriptions/titles language preferences (empty string = follow app
    // language, mapped to null at the API boundary).
    let metadataLanguage = $state('');
    let metadataTitleLanguage = $state('');
    let metadataLanguageSaving = $state(false);
    let metadataTitleLanguageSaving = $state(false);
    let metadataLanguageStatus = $state<'saved' | 'error' | ''>('');
    let metadataTitleLanguageStatus = $state<'saved' | 'error' | ''>('');
    let searchStatus = $state<'saved' | 'error' | ''>('');

    // Until the saved values arrive the pickers are disabled: a change made
    // against the '' placeholder was overwritten by the late GET, so the screen
    // showed one language while another was saved.
    let metadataPrefsLoaded = $state(false);

    async function loadMetadataLanguagePrefs(): Promise<void> {
        try {
            const { data } = await userApi.getPlaybackPreferences();
            metadataLanguage = data?.metadataLanguage ?? '';
            metadataTitleLanguage = data?.metadataTitleLanguage ?? '';
        } catch {
            /* ignore */
        } finally {
            metadataPrefsLoaded = true;
        }
    }

    async function handleMetadataLanguageChange(event: Event): Promise<void> {
        if (metadataLanguageSaving) return;
        const value = (event.currentTarget as HTMLSelectElement).value;
        const prev = metadataLanguage;
        metadataLanguage = value;
        metadataLanguageSaving = true;
        metadataLanguageStatus = '';
        try {
            const { error } = await userApi.updatePlaybackPreferences({
                metadataLanguage: value === '' ? null : value,
            });
            if (error) metadataLanguage = prev;
            metadataLanguageStatus = error ? 'error' : 'saved';
        } catch {
            metadataLanguage = prev;
            metadataLanguageStatus = 'error';
        } finally {
            metadataLanguageSaving = false;
        }
    }

    async function handleMetadataTitleLanguageChange(event: Event): Promise<void> {
        if (metadataTitleLanguageSaving) return;
        const value = (event.currentTarget as HTMLSelectElement).value;
        const prev = metadataTitleLanguage;
        metadataTitleLanguage = value;
        metadataTitleLanguageSaving = true;
        metadataTitleLanguageStatus = '';
        try {
            const { error } = await userApi.updatePlaybackPreferences({
                metadataTitleLanguage: value === '' ? null : value,
            });
            if (error) metadataTitleLanguage = prev;
            metadataTitleLanguageStatus = error ? 'error' : 'saved';
        } catch {
            metadataTitleLanguage = prev;
            metadataTitleLanguageStatus = 'error';
        } finally {
            metadataTitleLanguageSaving = false;
        }
    }

    // Fulltext-search default (per-session override stays in the search modal)
    let fulltextDefault = $state(false);
    let searchLoading = $state(false);
    /**
     * The preference is only known after a client fetch. Until then the switch
     * is replaced by a placeholder: it used to render OFF, flip to ON a moment
     * later, and a click in between saved the wrong value.
     */
    let searchLoaded = $state(false);

    async function loadSearchPref(): Promise<void> {
        try {
            const { data } = await userApi.getSearchPreference();
            fulltextDefault = (data as { fulltextSearch?: boolean })?.fulltextSearch === true;
        } catch {
            /* ignore */
        } finally {
            searchLoaded = true;
        }
    }

    async function toggleFulltext(): Promise<void> {
        if (searchLoading || !searchLoaded) return;
        const prev = fulltextDefault;
        fulltextDefault = !fulltextDefault;
        searchLoading = true;
        searchStatus = '';
        try {
            const { error } = await userApi.updateSearchPreference({
                fulltextSearch: fulltextDefault,
            });
            if (error) fulltextDefault = prev;
            searchStatus = error ? 'error' : 'saved';
        } catch {
            fulltextDefault = prev;
            searchStatus = 'error';
        } finally {
            searchLoading = false;
        }
    }

    // "Show less like this" dampers — review + undo the soft, decaying signals.
    let dampers = $state<TasteDamperItem[]>([]);
    let dampersLoading = $state(true);

    async function loadDampers(): Promise<void> {
        dampersLoading = true;
        try {
            const { data, error } = await getActiveDampers();
            dampers = !error && data ? data.dampers : [];
        } catch {
            dampers = [];
        } finally {
            dampersLoading = false;
        }
    }

    async function showAgain(mediaId: string): Promise<void> {
        const prev = dampers;
        dampers = dampers.filter((d) => d.mediaId !== mediaId); // optimistic
        const { error } = await clearDamper(mediaId);
        if (error) {
            dampers = prev;
            toasts.error(m.settings_dampers_load_error());
        } else {
            toasts.info(m.settings_dampers_cleared_one());
        }
    }

    async function resetAllDampers(): Promise<void> {
        const prev = dampers;
        dampers = []; // optimistic
        const { error } = await clearAllDampers();
        if (error) {
            dampers = prev;
            toasts.error(m.settings_dampers_load_error());
        } else {
            toasts.info(m.settings_dampers_cleared_all());
        }
    }

    // ── Browser (OS) notifications ────────────────────────────────────────────
    // `$lib/notifications-desktop.ts` — Notifications API, not Push; see that
    // module's header. `enable()` is the ONLY thing that may ever call
    // `Notification.requestPermission()`, and it must run from this toggle's
    // click (a real user gesture) — never on page load. Default OFF.
    let desktopBusy = $state(false);
    /**
     * Until a real read lands, the toggle stays disabled — same rule as
     * PrivacySection's `loaded` flag (`settings/privacy`), for the same
     * reason: a click before that must never write back a placeholder.
     * `initDesktopNotificationsState()` is synchronous and idempotent (the
     * root layout already owns the live listener's lifecycle; calling it
     * again here only (re)populates this store's snapshot — see
     * notifications-desktop.ts's module doc), so `loaded` flips true right
     * after it returns rather than waiting on a network round trip.
     */
    let desktopNotificationsLoaded = $state(false);

    const desktopEnabled = $derived($desktopNotifications.enabled);
    const desktopPermission = $derived($desktopNotifications.permission);
    const desktopToggleDisabled = $derived(
        desktopBusy ||
            !desktopNotificationsLoaded ||
            desktopPermission === 'unsupported' ||
            desktopPermission === 'denied',
    );

    async function toggleDesktopNotifications(): Promise<void> {
        if (desktopToggleDisabled) return;
        desktopBusy = true;
        try {
            if (desktopEnabled) {
                disableDesktopNotifications();
            } else {
                await enableDesktopNotifications();
            }
        } finally {
            desktopBusy = false;
        }
    }

    onMount(() => {
        // Stream/listening privacy moved to PrivacySection (`/settings/privacy`);
        // this page no longer reads or writes those fields.
        void loadSearchPref();
        void loadDampers();
        if (showMetadataLanguagePickers) void loadMetadataLanguagePrefs();
        initDesktopNotificationsState();
        desktopNotificationsLoaded = true;

        // `Notification.permission` can be revoked from the browser's own
        // settings mid-session — there's no event for that, so re-read it
        // whenever this page is plausibly being looked at again (tab
        // refocused, or the user tabbed back to this settings page).
        // `refreshPermission()` also stops the live listener if a revoke is
        // caught while `enabled` was true.
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') refreshDesktopNotificationsPermission();
        };
        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('focus', refreshDesktopNotificationsPermission);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibility);
            window.removeEventListener('focus', refreshDesktopNotificationsPermission);
        };
    });
</script>

{#snippet saveFeedback(saving: boolean, status: 'saved' | 'error' | '')}
    <div class="px-4 text-xs" aria-live="polite" aria-atomic="true">
        {#if saving}
            <p class="py-2 text-surface-400">{m.saving()}</p>
        {:else if status === 'error'}
            <p role="alert" class="py-2 text-error-400">{m.viewer_settings_save_error()}</p>
        {:else if status === 'saved'}
            <p class="py-2 text-success-400">{m.viewer_settings_saved()}</p>
        {/if}
    </div>
{/snippet}

{#snippet toggleRow(
    icon: IconSource,
    label: string,
    hint: string,
    checked: boolean,
    onchange: () => void,
    disabled?: boolean,
)}
    <div class="flex items-center justify-between gap-4 py-3 px-4">
        <div class="flex items-center gap-2 min-w-0">
            <Icon src={icon} class="w-4 h-4 text-surface-400 shrink-0" />
            <div class="min-w-0">
                <span class="text-sm">{label}</span>
                {#if hint}
                    <p class="text-xs text-surface-400 mt-0.5">{hint}</p>
                {/if}
            </div>
        </div>
        <div class="shrink-0">
            <Toggle {label} {checked} {disabled} {onchange} />
        </div>
    </div>
{/snippet}

{#snippet selectRow(
    icon: IconSource,
    label: string,
    hint: string,
    value: string,
    options: { value: string; label: string }[],
    onchange: (e: Event) => void,
    disabled?: boolean,
)}
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 px-4">
        <div class="flex items-center gap-2 min-w-0">
            <Icon src={icon} class="w-4 h-4 text-surface-400 shrink-0" />
            <div class="min-w-0">
                <span class="text-sm">{label}</span>
                {#if hint}
                    <p class="text-xs text-surface-400 mt-0.5">{hint}</p>
                {/if}
            </div>
        </div>
        <select
            class="select select-sm w-auto max-w-full text-sm"
            aria-label={label}
            {value}
            {disabled}
            {onchange}>
            {#each options as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
            {/each}
        </select>
    </div>
{/snippet}

<SettingsGroup label={m.settings_display_group_language()}>
    {@render selectRow(
        Language,
        m.settings_display_interface_language(),
        '',
        currentLocale,
        locales.map((l) => ({ value: l, label: localeNames[l] ?? l })),
        handleLocaleChange,
    )}
    {#if enabledThemes.length > 0}
        {@render selectRow(
            Swatch,
            m.settings_display_theme(),
            m.settings_display_theme_hint(),
            currentTheme,
            enabledThemes.map((t) => ({ value: t.id, label: t.name })),
            handleThemeChange,
        )}
    {/if}
    {#if showMetadataLanguagePickers}
        {@render selectRow(
            Language,
            m.settings_metadata_lang_descriptions_label(),
            m.settings_metadata_lang_description(),
            metadataLanguage,
            metadataLanguageOptions,
            handleMetadataLanguageChange,
            metadataLanguageSaving || !metadataPrefsLoaded,
        )}
        {@render saveFeedback(metadataLanguageSaving, metadataLanguageStatus)}
        {@render selectRow(
            Language,
            m.settings_metadata_lang_titles_label(),
            '',
            metadataTitleLanguage,
            metadataLanguageOptions,
            handleMetadataTitleLanguageChange,
            metadataTitleLanguageSaving || !metadataPrefsLoaded,
        )}
        {@render saveFeedback(metadataTitleLanguageSaving, metadataTitleLanguageStatus)}
    {/if}
</SettingsGroup>

<SettingsGroup label={m.settings_display_group_browsing()}>
    {#if showDockToggle}
        {@render toggleRow(
            ViewColumns,
            m.settings_display_dock(),
            m.settings_display_dock_hint(),
            $dockVisible,
            () => toggleDockHidden(),
        )}
    {/if}
    {#if $page.data?.features?.youtubeHero}
        {@render toggleRow(
            Film,
            m.settings_display_hero_autoplay_video(),
            m.settings_display_hero_autoplay_video_hint(),
            $uiPreferences.heroAutoplayVideo,
            () => uiPreferences.toggleHeroAutoplayVideo(),
        )}
    {/if}
    {#if $page.data?.features?.mediaHoverVideoPreview && canHover}
        {@render toggleRow(
            PlayCircle,
            m.settings_display_poster_hover_preview(),
            m.settings_display_poster_hover_preview_hint(),
            $uiPreferences.posterHoverPreview,
            () => uiPreferences.togglePosterHoverPreview(),
        )}
    {/if}
    {@render toggleRow(
        InformationCircle,
        m.footer_stream_tech_info(),
        m.settings_display_stream_tech_info_hint(),
        $uiPreferences.showStreamTechInfo,
        () => uiPreferences.toggleStreamTechInfo(),
    )}
    <PreferenceSettingsGate>
        {@render toggleRow(
            Language,
            m.settings_display_episode_languages(),
            m.settings_display_episode_languages_hint(),
            playbackPreferences.showEpisodeLanguages,
            () =>
                updatePreference('showEpisodeLanguages', !playbackPreferences.showEpisodeLanguages),
        )}
    </PreferenceSettingsGate>
    {#if searchLoaded}
        {@render toggleRow(
            MagnifyingGlass,
            m.settings_display_fulltext_search_default(),
            m.settings_display_fulltext_search_hint(),
            fulltextDefault,
            toggleFulltext,
            searchLoading,
        )}
    {:else}
        <div class="flex items-center justify-between gap-4 py-3 px-4" aria-busy="true">
            <div class="flex items-center gap-2 min-w-0">
                <Icon src={MagnifyingGlass} class="w-4 h-4 text-surface-400 shrink-0" />
                <div class="min-w-0">
                    <span class="text-sm">{m.settings_display_fulltext_search_default()}</span>
                    <p class="text-xs text-surface-400 mt-0.5">
                        {m.settings_display_fulltext_search_hint()}
                    </p>
                </div>
            </div>
            <span class="block w-11 h-6 rounded-full bg-surface-700 animate-pulse shrink-0"></span>
        </div>
    {/if}
    {@render saveFeedback(searchLoading, searchStatus)}
</SettingsGroup>

<SettingsGroup label={m.settings_display_notifications()}>
    <div class="flex items-center justify-between py-3 px-4 gap-4">
        <div class="flex items-center gap-2 min-w-0">
            <Icon src={Bell} class="w-4 h-4 text-surface-400 shrink-0" />
            <div class="min-w-0">
                <span class="text-sm">{m.settings_display_desktop_notifications_title()}</span>
                <p class="text-xs text-surface-500 mt-0.5">
                    {#if !desktopNotificationsLoaded}
                        {m.settings_display_desktop_notifications_hint()}
                    {:else if desktopPermission === 'unsupported'}
                        {m.settings_display_desktop_notifications_unsupported()}
                    {:else if desktopPermission === 'denied'}
                        {m.settings_display_desktop_notifications_denied()}
                    {:else if $desktopNotifications.registrationFailed}
                        {m.settings_display_desktop_notifications_failed()}
                    {:else}
                        {m.settings_display_desktop_notifications_hint()}
                    {/if}
                </p>
            </div>
        </div>
        <div class="shrink-0">
            <Toggle
                label={m.settings_display_desktop_notifications_title()}
                checked={desktopEnabled}
                disabled={desktopToggleDisabled}
                onchange={toggleDesktopNotifications} />
        </div>
    </div>
    <!-- Admin-gated, default OFF. Hidden entirely rather than shown disabled:
         on an install where the operator never enabled it there is nothing for
         the user to do about it, and a permanently-dead control in a settings
         list reads as a bug. -->
    {#if $page.data?.features?.userNotificationWebhooks === true}
        <NotificationWebhookPanel />
    {/if}
    <!-- Hides itself unless the admin set up an integration (or the user had
         already opted in) — see the component header. -->
    <NotificationForwardingPanel />
</SettingsGroup>

<SettingsGroup label={m.settings_reco_tuning()}>
    <div class="px-4 py-3">
        <div class="flex items-start gap-2 mb-3">
            <Icon src={EyeSlash} class="w-4 h-4 text-surface-400 shrink-0 mt-0.5" />
            <div class="min-w-0">
                <span class="text-sm">{m.settings_dampers_title()}</span>
                <p class="text-xs text-surface-500 mt-0.5">{m.settings_dampers_hint()}</p>
            </div>
        </div>

        {#if dampersLoading}
            <p class="text-xs text-surface-500 py-2">…</p>
        {:else if dampers.length === 0}
            <p class="text-xs text-surface-500 py-2">{m.settings_dampers_empty()}</p>
        {:else}
            <ul class="space-y-1">
                {#each dampers as d (d.mediaId)}
                    <li class="flex items-center gap-3 rounded-md bg-surface-800/40 px-2 py-1.5">
                        <img
                            src={getCatalogPosterUrl(d.mediaId, { size: 'thumb' })}
                            alt=""
                            loading="lazy"
                            class="h-10 w-7 shrink-0 rounded object-cover bg-surface-700" />
                        <span class="min-w-0 flex-1 truncate text-sm">{d.title}</span>
                        <button
                            type="button"
                            class="btn btn-sm variant-ghost-surface flex items-center gap-1 text-xs"
                            onclick={() => showAgain(d.mediaId)}>
                            <Icon src={ArrowUturnLeft} class="w-3.5 h-3.5" />
                            <span class="hidden sm:inline">{m.settings_dampers_show_again()}</span>
                        </button>
                    </li>
                {/each}
            </ul>
            <div class="mt-3 flex justify-end">
                <button
                    type="button"
                    class="btn btn-sm variant-ghost-error text-xs"
                    onclick={resetAllDampers}>
                    {m.settings_dampers_clear_all()}
                </button>
            </div>
        {/if}
    </div>
</SettingsGroup>
