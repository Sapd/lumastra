// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Badge color per diagnostic `kind`, for the `.badge-soft-*` classes in
 * `global-components.css`. Colors only — the label text is translated in
 * +page.svelte via `m.admin_clientdiag_kind_*()`, kept out of this pure
 * module so it never needs its own i18n plumbing.
 */

import type { DiagnosticKind } from '$lib/schemas/client-diagnostics.js';

const KIND_BADGE_COLOR: Record<DiagnosticKind, string> = {
    playback_incident: 'orange',
    crash: 'red',
    hang: 'yellow',
    js_error: 'purple',
    api_failures: 'cyan',
    log_bundle: 'blue',
    compat_incident: 'green',
};

export function kindBadgeColor(kind: DiagnosticKind): string {
    return KIND_BADGE_COLOR[kind];
}
