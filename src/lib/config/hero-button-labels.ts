// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Labels for the home page hero buttons.
 *
 * The admin editor used to create the built-in buttons with `m.search()` etc.
 * evaluated in the ADMIN's language at that moment and stored the result as a
 * plain string — so on a German-run install every English viewer saw "Suchen", "Stöbern",
 * "Assistent". Two fixes live here:
 *
 *  - {@link heroButtonLabel}: a built-in action whose stored label is still one
 *    of our own defaults (in any language) is shown in the viewer's language;
 *    an admin's own wording is kept as typed. An explicit translation in
 *    `labels` always wins.
 *  - {@link allLocaleLabels}: the editor now stores every language's default
 *    alongside the label, so new buttons are translated from the start.
 */

import * as m from '$lib/paraglide/messages';
import { locales } from '$lib/paraglide/runtime.js';
import { pickLabel, type LocalizedLabels } from '$lib/shared/localized-label';

type Message = (
    inputs?: Record<string, never>,
    options?: { locale?: (typeof locales)[number] },
) => string;

const BUILT_IN_MESSAGES: Record<string, Message> = {
    search: m.search,
    browse: m.browse,
    assistant: m.assistant_label,
};

/** `{ en: "Search", de: "Suchen" }` for a message. */
export function allLocaleLabels(message: Message): LocalizedLabels {
    const out: LocalizedLabels = {};
    for (const locale of locales) out[locale] = message({}, { locale });
    return out;
}

export interface HeroButtonLike {
    action: string;
    label: string;
    labels?: LocalizedLabels;
}

/** Where the editor's "Connect Jellyfin client" preset points. */
export const JELLYFIN_CONNECT_URL = '/settings/connections?connect=jellyfin';

/** Past and present spellings of that preset's label (e.g. "Jellyfin Client Verbinden"). */
const JELLYFIN_CONNECT_LEGACY = ['connect jellyfin client', 'jellyfin client verbinden'];

function normalize(text: string): string {
    return text.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
}

export function heroButtonLabel(btn: HeroButtonLike & { url?: string }, locale: string): string {
    if (btn.labels?.[locale]?.trim()) return pickLabel(btn, locale);
    if (btn.action === 'link' && btn.url === JELLYFIN_CONNECT_URL) {
        const known = [
            ...JELLYFIN_CONNECT_LEGACY,
            ...Object.values(allLocaleLabels(m.settings_connections_connect_client)).map((t) =>
                normalize(t ?? ''),
            ),
        ];
        if (known.includes(normalize(btn.label))) {
            return m.settings_connections_connect_client(
                {},
                { locale: locale as (typeof locales)[number] },
            );
        }
    }
    const message = BUILT_IN_MESSAGES[btn.action];
    if (message) {
        const defaults = Object.values(allLocaleLabels(message));
        if (!btn.label.trim() || defaults.includes(btn.label.trim())) {
            return message({}, { locale: locale as (typeof locales)[number] });
        }
    }
    return pickLabel(btn, locale);
}

/**
 * The account-menu links the editor seeds. Older configs stored them as plain
 * English ("All Apps", "Change Password"); one install typed them in German. A
 * link still carrying one of those texts is shown in the viewer's language.
 */
const MENU_LINK_DEFAULTS: { message: Message; legacy: string[] }[] = [
    { message: m.usermenu_default_all_apps, legacy: ['All Apps'] },
    { message: m.usermenu_default_change_password, legacy: ['Change Password'] },
];

export function userMenuLinkLabel(
    link: { label: string; labels?: LocalizedLabels },
    locale: string,
): string {
    if (link.labels?.[locale]?.trim()) return pickLabel(link, locale);
    const text = link.label.trim().toLowerCase();
    for (const { message, legacy } of MENU_LINK_DEFAULTS) {
        const known = [...Object.values(allLocaleLabels(message)), ...legacy].map((t) =>
            (t ?? '').toLowerCase(),
        );
        if (known.includes(text)) {
            return message({}, { locale: locale as (typeof locales)[number] });
        }
    }
    return pickLabel(link, locale);
}
