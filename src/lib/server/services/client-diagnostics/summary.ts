// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** One-line human summaries for the admin list view, and the short reference id shown next to an eventId. */

import type { DiagnosticKind } from '$lib/schemas/client-diagnostics.js';

const MAX = 200;
const clip = (s: string): string => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);
const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

export function summaryFor(kind: DiagnosticKind, p: Record<string, unknown>): string | null {
    switch (kind) {
        case 'playback_incident':
            return clip(
                str(p.message) ?? str(p.errorType) ?? str(p.triggerType) ?? 'playback incident',
            );
        case 'crash':
        case 'hang':
            return clip(str(p.exceptionName) ?? str(p.terminationReason) ?? str(p.source) ?? kind);
        case 'js_error': {
            if (p.origin === 'error_toast') {
                const c = (p.cause ?? {}) as Record<string, unknown>;
                const cause = str(c.route)
                    ? ` ← ${str(c.method) ?? '?'} ${str(c.route)}${typeof c.status === 'number' ? ` ${c.status}` : ''}`
                    : '';
                return clip(`Failure shown: ${str(p.toastKey) ?? 'untagged'}${cause}`);
            }
            return clip(`${str(p.name) ?? 'Error'}: ${str(p.message) ?? ''}`);
        }
        case 'api_failures':
            return clip(
                `${str(p.method) ?? '?'} ${str(p.route) ?? '?'} → ${str(p.outcome) ?? '?'}${typeof p.status === 'number' ? ` ${p.status}` : ''}${str(p.problemCode) ? ` ${str(p.problemCode)}` : ''}${str(p.keyPath) ? ` @ ${str(p.keyPath)}` : ''}`,
            );
        case 'log_bundle':
            return clip(str(p.note) ?? 'Log bundle');
        case 'compat_incident': {
            const client = [str(p.clientName), str(p.clientVersion)].filter(Boolean).join(' ');
            return clip(`Jellyfin client: playback never started (${client || 'unknown'})`);
        }
    }
}

export function shortIdFor(eventId: string): string {
    const hex = eventId.replace(/-/g, '').slice(0, 8).toUpperCase();
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}
