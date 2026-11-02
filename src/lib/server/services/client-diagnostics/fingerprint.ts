// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Groups events into a stable bucket regardless of instance-specific numbers
 * (line numbers, ids, offsets). `playback_incident` has no fingerprint — it
 * is already grouped by `attemptId`.
 */

import { createHash } from 'node:crypto';
import type { DiagnosticEventInput } from '$lib/schemas/client-diagnostics.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

function normalizeMessage(message: string): string {
    return message
        .replace(/(["'`]).*?\1/g, '"…"')
        .replace(/0x[0-9a-f]+/gi, '#')
        .replace(/\d+/g, '#')
        .trim()
        .slice(0, 300);
}

function topFrame(stack: string | undefined): string {
    const line =
        (stack ?? '')
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.startsWith('at ') || l.includes('@')) ?? '';
    return line.replace(/:\d+(:\d+)?\)?$/, '').replace(/\?[^\s)]*/, '');
}

export function fingerprintFor(event: DiagnosticEventInput): string | null {
    switch (event.kind) {
        case 'crash':
        case 'hang': {
            const p = event.payload;
            const stack = p.callStacks.find((s) => s.threadAttributed) ?? p.callStacks[0];
            const top = (stack?.frames ?? [])
                .slice(0, 5)
                .map(
                    (f) => `${f.binaryUUID ?? f.binaryName ?? '?'}:${f.offset ?? f.address ?? '?'}`,
                );
            if (top.length > 0) return sha(`${event.kind}|${top.join('|')}`);
            return sha(`${event.kind}|${p.source}|${p.exceptionName ?? ''}`);
        }
        case 'js_error': {
            const p = event.payload;
            // A failure message groups by what the user saw, where, and the call
            // behind it — not by the stack of whatever code raised the toast.
            if (p.origin === 'error_toast') {
                const c = p.cause;
                return sha(
                    `toast|${p.toastKey ?? ''}|${p.route ?? ''}|${c ? `${c.method} ${c.route} ${c.outcome} ${c.problemCode ?? ''}` : ''}`,
                );
            }
            return sha(`js|${p.name}|${normalizeMessage(p.message)}|${topFrame(p.stack)}`);
        }
        case 'api_failures': {
            const p = event.payload;
            return sha(
                `api|${p.method}|${p.route}|${p.outcome}${p.outcome === 'decode' ? `|${p.keyPath ?? ''}` : ''}${p.problemCode ? `|${p.problemCode}` : ''}`,
            );
        }
        case 'playback_incident':
            return null;
    }
}
