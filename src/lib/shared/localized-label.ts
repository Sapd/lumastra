// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-language labels for admin-configured navigation (sidebar links and
 * sections, user-menu links, footer links, hero buttons).
 *
 * Those items used to carry exactly one `label` string, typed once by an admin
 * in whatever language they happened to use — so an English interface showed
 * "Alle Apps" and "Suchen". `labels` is an optional map of locale → label; the
 * plain `label` stays the fallback, so every existing config keeps working
 * unchanged and a translation is only ever an addition.
 */

export type LocalizedLabels = Partial<Record<string, string>>;

export interface Labelled {
    label: string;
    labels?: LocalizedLabels;
}

/** The label to show in `locale`: its translation if set, else the plain label. */
export function pickLabel(item: Labelled, locale: string): string {
    const translated = item.labels?.[locale]?.trim();
    return translated || item.label;
}

/**
 * Copies of `items` whose `label` is already resolved for `locale`. Used where
 * the list is handed to rendering code that only knows `label`.
 */
export function localizeItems<T extends Labelled>(items: readonly T[], locale: string): T[] {
    return items.map((item) => (item.labels ? { ...item, label: pickLabel(item, locale) } : item));
}

/**
 * Drop empty entries so a cleared translation field does not persist as "".
 * Returns undefined when nothing is left, keeping stored configs minimal.
 */
export function cleanLabels(labels: LocalizedLabels | undefined): LocalizedLabels | undefined {
    if (!labels) return undefined;
    const out: LocalizedLabels = {};
    for (const [locale, value] of Object.entries(labels)) {
        const v = value?.trim();
        if (v) out[locale] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
