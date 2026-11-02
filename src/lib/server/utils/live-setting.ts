// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A connection setting a long-lived client can hold: a fixed string (tests,
 * one-off clients) or a function re-read on every use. The module-level
 * singletons (`sonarrClient`, `jellyseerrClient`, `audiobookshelfClient`, …)
 * are built at import; with a function they follow a saved URL/key instead of
 * keeping the boot value until a restart.
 */
export type SettingSource = string | (() => string);

export function readSetting(source: SettingSource): string {
    return typeof source === 'function' ? source() : source;
}
