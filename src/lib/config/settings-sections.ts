// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { IconSource } from 'svelte-hero-icons';
import {
    UserCircle,
    DevicePhoneMobile,
    ServerStack,
    Cog6Tooth,
    Film,
    ChatBubbleLeftRight,
    Squares2x2,
    InformationCircle,
    Trash,
    EyeSlash,
} from 'svelte-hero-icons';

/** Inputs that decide which settings sections a user can see. */
export interface SettingsVisibilityContext {
    /**
     * `$page.data.features` — the SSR feature matrix. Typed as `AppFeatures`
     * rather than `Record<string, boolean>`: every predicate below reads a NAMED
     * flag (`avatarUpload`, `userPats`, `jellyfinCompat`, …), and the record form
     * only ever matched because the layout's value used to degrade to `{}`.
     */
    features: NonNullable<App.PageData['features']>;
    /** `$page.data.authMethod`; native-login sessions are `'session'`. */
    authMethod: string | undefined;
    /** Whether the user has any customizable home widgets. */
    hasWidgets: boolean;
    /** Whether a MyAnimeList OAuth app is configured on this deployment. */
    malConfigured: boolean;
}

export interface SettingsSection {
    /** Route segment under /settings, e.g. 'account'. */
    id: string;
    /** Sidebar label. */
    label: string;
    icon: IconSource;
    /** True when this section has at least one visible control for the user. */
    isEnabled: (ctx: SettingsVisibilityContext) => boolean;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
    {
        id: 'account',
        label: 'Account',
        icon: UserCircle,
        isEnabled: (c) =>
            c.features.avatarUpload !== false ||
            c.authMethod === 'session' ||
            c.features.userPats === true,
    },
    {
        id: 'sessions',
        label: 'Sessions & Devices',
        icon: DevicePhoneMobile,
        isEnabled: () => true, // Active Streams is universal
    },
    {
        id: 'connections',
        label: 'Connections',
        icon: ServerStack,
        isEnabled: (c) =>
            c.features.jellyfinCompat === true ||
            c.features.subsonicCompat === true ||
            c.malConfigured,
    },
    { id: 'display', label: 'Display', icon: Cog6Tooth, isEnabled: () => true },
    {
        id: 'privacy',
        label: 'Privacy',
        icon: EyeSlash,
        // Always available. `hide_streams` applies on every install regardless of
        // feature flags, so there is no configuration under which this section has
        // nothing to show — and a privacy page that disappears is worse than one
        // with a single control.
        isEnabled: () => true,
    },
    { id: 'playback', label: 'Playback', icon: Film, isEnabled: () => true },
    {
        id: 'subtitles',
        label: 'Subtitles',
        icon: ChatBubbleLeftRight,
        isEnabled: () => true,
    },
    {
        id: 'home',
        label: 'Home',
        icon: Squares2x2,
        isEnabled: (c) => c.hasWidgets,
    },
    { id: 'about', label: 'About', icon: InformationCircle, isEnabled: () => true },
    { id: 'data', label: 'Reset Data', icon: Trash, isEnabled: () => true },
];

export function enabledSections(ctx: SettingsVisibilityContext): SettingsSection[] {
    return SETTINGS_SECTIONS.filter((s) => s.isEnabled(ctx));
}

export function isSectionEnabled(id: string, ctx: SettingsVisibilityContext): boolean {
    const section = SETTINGS_SECTIONS.find((s) => s.id === id);
    return section ? section.isEnabled(ctx) : false;
}

export function firstEnabledSectionId(ctx: SettingsVisibilityContext): string | undefined {
    return enabledSections(ctx)[0]?.id;
}

/**
 * Returns the path to redirect to when `id` is NOT visible for this user,
 * or `null` when `id` is visible (no redirect needed).
 */
export function settingsRedirectTarget(id: string, ctx: SettingsVisibilityContext): string | null {
    if (isSectionEnabled(id, ctx)) return null;
    const first = firstEnabledSectionId(ctx);
    return first ? `/settings/${first}` : '/';
}
