// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages';

export interface SettingsSearchEntry {
    /** Section the control lives in (must match a SETTINGS_SECTIONS id). */
    sectionId: string;
    /**
     * The control's visible label, resolved per locale at search time (so a
     * locale switch re-localizes results). Call it: `entry.label()`.
     */
    label: () => string;
    /** Synonyms/aliases users may type instead of our vocabulary (en + de). */
    keywords: string[];
    /**
     * Optional query string (no leading `?`) appended to the section link so
     * this result deep-links straight into a control instead of just the
     * section, e.g. `connect=jellyfin` opens the Jellyfin connect modal.
     * The value must already be URL-encoded by whoever writes the entry.
     */
    query?: string;
    /**
     * Only offer this entry to users signed in this way. The account password
     * exists only for built-in logins; SSO users were sent to an Account page
     * with no password on it.
     */
    authMethod?: 'session';
}

export interface SearchContext {
    /** `$page.data.authMethod` (e.g. 'session', 'forward_auth'). */
    authMethod?: string;
}

export interface SettingsSearchHit {
    sectionId: string;
    label: string;
    query?: string;
}

/**
 * Static index mapping user vocabulary -> controls -> section. The keyword
 * synonyms exist because users type "captions"/"dark mode"/"sessions", not our
 * labels — and now also their German equivalents. Labels are localized via
 * Paraglide so a German query also matches the German label. Keep sectionId in
 * sync with settings-sections.ts.
 */
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
    {
        sectionId: 'subtitles',
        label: () => m.settings_search_label_subtitle_language(),
        keywords: [
            'subtitle',
            'subtitles',
            'captions',
            'cc',
            'sdh',
            'closed captions',
            'language',
            'untertitel',
            'sprache',
        ],
    },
    {
        sectionId: 'subtitles',
        label: () => m.settings_search_label_subtitle_appearance(),
        keywords: [
            'subtitle',
            'font',
            'size',
            'color',
            'outline',
            'shadow',
            'position',
            'style',
            'untertitel',
            'schriftart',
            'darstellung',
            'farbe',
        ],
    },
    {
        sectionId: 'playback',
        label: () => m.settings_search_label_audio_language(),
        keywords: ['audio', 'language', 'sound', 'dub', 'ton', 'sprache', 'synchronisation'],
    },
    {
        sectionId: 'playback',
        label: () => m.settings_search_label_prefer_original_audio(),
        keywords: [
            'original',
            'original language',
            'subs not dubs',
            'sub',
            'undubbed',
            'anime',
            'japanese',
            'originalsprache',
            'originalton',
            'omu',
            'untertitel statt synchro',
        ],
    },
    {
        sectionId: 'playback',
        label: () => m.settings_search_label_autoplay(),
        keywords: [
            'autoplay',
            'auto play',
            'next episode',
            'binge',
            'automatisch',
            'nächste folge',
            'still watching',
            'are you still watching',
            'asleep',
            'schaust du noch',
            'eingeschlafen',
        ],
    },
    {
        sectionId: 'playback',
        label: () => m.settings_search_label_skip(),
        keywords: ['skip', 'intro', 'credits', 'recap', 'überspringen', 'abspann'],
    },
    {
        sectionId: 'playback',
        label: () => m.settings_playback_next_countdown(),
        keywords: ['countdown', 'timer', 'next episode', 'wartezeit', 'nächste folge'],
        query: 'highlight=autoplay',
    },
    {
        sectionId: 'playback',
        label: () => m.settings_playback_show_next_popup(),
        keywords: ['popup', 'next episode prompt', 'vorschau', 'nächste folge'],
        query: 'highlight=show-next-popup',
    },
    {
        sectionId: 'playback',
        label: () => m.settings_playback_seek_step(),
        keywords: ['seek', 'skip step', 'forward', 'rewind', 'vorspulen', 'zurückspulen'],
    },
    {
        sectionId: 'playback',
        label: () => m.settings_search_label_quality(),
        keywords: ['quality', 'bitrate', 'resolution', 'data', 'qualität', 'auflösung'],
    },
    {
        sectionId: 'display',
        label: () => m.settings_search_label_interface_language(),
        keywords: ['language', 'locale', 'german', 'deutsch', 'english', 'sprache', 'oberfläche'],
    },
    {
        sectionId: 'display',
        label: () => m.settings_search_label_dock(),
        keywords: ['dock', 'sidebar', 'seitenleiste'],
    },
    {
        sectionId: 'display',
        label: () => m.settings_search_label_stream_tech(),
        keywords: ['stream', 'tech', 'info', 'transcode', 'technik', 'transkodierung'],
    },
    {
        sectionId: 'display',
        label: () => m.settings_display_episode_languages(),
        keywords: [
            'episode',
            'audio',
            'subtitle',
            'language',
            'badges',
            'folge',
            'sprachen',
            'untertitel',
        ],
    },
    {
        // Lives on Privacy since the privacy split — this entry still pointed at
        // Display, which no longer has the switch.
        sectionId: 'privacy',
        label: () => m.settings_search_label_hide_streams(),
        keywords: [
            'privacy',
            'hide',
            'streams',
            'presence',
            'private',
            'privatsphäre',
            'verbergen',
            'privat',
        ],
    },
    {
        sectionId: 'display',
        label: () => m.settings_search_label_search_mode(),
        keywords: ['search', 'fulltext', 'semantic', 'suche', 'suchmodus'],
    },
    {
        sectionId: 'display',
        label: () => m.settings_search_label_metadata_language(),
        keywords: [
            'metadata',
            'descriptions',
            'titles',
            'translation',
            'overview',
            'metadaten',
            'beschreibung',
            'titel',
            'übersetzung',
        ],
    },
    {
        sectionId: 'display',
        label: () => m.settings_display_theme(),
        keywords: ['theme', 'colors', 'colours', 'dark mode', 'appearance', 'design', 'farben'],
    },
    {
        sectionId: 'display',
        label: () => m.settings_display_desktop_notifications_title(),
        keywords: ['notifications', 'notify', 'alerts', 'benachrichtigungen', 'mitteilungen'],
    },
    {
        sectionId: 'display',
        label: () => m.settings_display_hero_autoplay_video(),
        keywords: ['trailer', 'preview', 'autoplay video', 'hero', 'vorschau', 'hover'],
    },
    {
        sectionId: 'display',
        label: () => m.settings_dampers_title(),
        keywords: ['less like', 'not interested', 'recommendations', 'weniger', 'empfehlungen'],
    },
    {
        sectionId: 'privacy',
        label: () => m.settings_audiobook_sharing_title(),
        keywords: ['audiobook', 'listening', 'share', 'hörbuch', 'teilen', 'privacy'],
    },
    {
        sectionId: 'subtitles',
        label: () => m.settings_subtitles_show_label(),
        keywords: ['subtitle', 'subtitles on', 'captions', 'untertitel'],
    },
    {
        sectionId: 'subtitles',
        label: () => m.settings_subtitles_forced_label(),
        keywords: ['forced', 'subtitle', 'signs', 'foreign', 'erzwungen', 'untertitel'],
    },
    {
        sectionId: 'playback',
        label: () => m.settings_connection_test_label(),
        keywords: [
            'speed',
            'speed test',
            'connection',
            'buffering',
            'bandwidth',
            'network',
            'geschwindigkeit',
            'verbindung',
            'puffern',
        ],
    },
    {
        sectionId: 'connections',
        label: () => m.settings_connections_trakt_label(),
        keywords: ['trakt', 'scrobble', 'watch history sync', 'sync'],
    },
    {
        sectionId: 'connections',
        label: () => m.settings_connections_mal_label(),
        keywords: ['mal', 'myanimelist', 'anime list', 'sync'],
    },
    {
        sectionId: 'sessions',
        label: () => m.settings_section_sessions(),
        keywords: [
            'devices',
            'sessions',
            'streams',
            'logins',
            'sign out',
            'log out',
            'logout',
            'revoke',
            'tvos',
            'geräte',
            'abmelden',
            'sitzungen',
        ],
    },
    {
        sectionId: 'connections',
        label: () => m.settings_search_label_connections(),
        keywords: [
            'jellyfin',
            'subsonic',
            'plex',
            'mal',
            'myanimelist',
            'anime',
            'sync',
            'connect',
            'verbinden',
            'verbindung',
        ],
    },
    {
        sectionId: 'connections',
        label: () => m.settings_connections_connect_client(),
        keywords: [
            'jellyfin',
            'connect jellyfin',
            'link jellyfin',
            'jellyfin client',
            'quick connect',
            'swiftfin',
            'findroid',
            'infuse',
            'verbinden',
        ],
        query: 'connect=jellyfin',
    },
    {
        sectionId: 'connections',
        label: () => m.settings_connections_connect_music(),
        keywords: ['subsonic', 'connect music', 'music apps', 'music client', 'musik'],
        query: 'connect=subsonic',
    },
    {
        sectionId: 'account',
        label: () => m.settings_search_label_password(),
        keywords: ['password', 'change password', 'passwort', 'kennwort'],
        authMethod: 'session',
    },
    {
        // The only password an SSO user has here is the Jellyfin client one.
        sectionId: 'connections',
        label: () => m.jellyfin_connect_client_password_label(),
        keywords: [
            'password',
            'pin',
            'client password',
            'jellyfin password',
            'passwort',
            'kennwort',
        ],
        query: 'connect=jellyfin',
    },
    {
        sectionId: 'account',
        label: () => m.settings_account_sign_out(),
        keywords: ['sign out', 'log out', 'logout', 'abmelden', 'ausloggen', 'profile', 'profil'],
    },
    {
        sectionId: 'account',
        label: () => m.settings_search_label_api_tokens(),
        keywords: [
            'api',
            'token',
            'api token',
            'pat',
            'developer',
            'key',
            'schlüssel',
            'entwickler',
        ],
    },
    {
        sectionId: 'account',
        label: () => m.settings_search_label_avatar(),
        keywords: ['avatar', 'photo', 'picture', 'image', 'profilbild', 'bild'],
    },
    {
        sectionId: 'home',
        label: () => m.settings_search_label_home_widgets(),
        keywords: ['home', 'widgets', 'layout', 'sections', 'rearrange', 'startseite', 'bereiche'],
    },
    {
        sectionId: 'about',
        label: () => m.settings_search_label_about(),
        keywords: ['about', 'legal', 'license', 'version', 'über', 'lizenz', 'rechtliches'],
    },
    {
        sectionId: 'data',
        label: () => m.settings_search_label_reset_data(),
        keywords: [
            'reset',
            'clear',
            'delete history',
            'wipe',
            'listening history',
            'watch history',
            'recommendations',
            'zurücksetzen',
            'löschen',
            'verlauf',
        ],
    },
];

/**
 * Filter the index by a free-text query, returning only hits whose section is
 * currently enabled. Matches the (localized) control label OR any synonym
 * (either direction, so "api token" matches "api" and vice versa).
 */
export function searchSettings(
    query: string,
    enabledSectionIds: ReadonlySet<string>,
    context: SearchContext = {},
): SettingsSearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (
        SETTINGS_SEARCH_INDEX.filter((e) => enabledSectionIds.has(e.sectionId))
            .filter((e) => !e.authMethod || e.authMethod === context.authMethod)
            // Match the label or any keyword as a prefix/substring of the query token.
            // Note: we deliberately do NOT also test `q.includes(k)` — that direction
            // produced false positives where a short keyword is a substring of an
            // unrelated query (e.g. "cc" inside "account", "data" inside "database").
            .filter(
                (e) => e.label().toLowerCase().includes(q) || e.keywords.some((k) => k.includes(q)),
            )
            .map((e) => ({ sectionId: e.sectionId, label: e.label(), query: e.query }))
    );
}
