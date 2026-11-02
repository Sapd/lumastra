// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { browser, version } from '$app/environment';
import type { z } from 'zod';
import { apiUrl, appPath } from '$lib/shared/api-urls.js';
import { diagnosticKeyPath } from '$lib/shared/client-diagnostics-routing.js';
import { diagnosticPathTemplate } from '$lib/client-diagnostics/route-template.js';
import type { DiagnosticEventInput } from '$lib/schemas/client-diagnostics.js';
import { recordDiagnostic } from '$lib/client-diagnostics/web-reporter.js';

const seen = new Set<string>();

/** Best effort, once per (method, server route, first issue path) per page load. */
export function reportApiContractMismatch(
    endpoint: string,
    method: string,
    status: number,
    error: z.ZodError,
): void {
    if (!browser) return;
    try {
        const route = diagnosticPathTemplate(appPath(endpoint));
        if (
            route === apiUrl('internal', '/diagnostics/events') ||
            route === apiUrl('v1', '/diagnostics/events')
        )
            return;
        const keyPath = diagnosticKeyPath(error.issues[0]?.path ?? []);
        const key = JSON.stringify([method, route, keyPath]);
        if (seen.has(key) || seen.size >= 20) return;
        const now = Date.now();
        const issue = error.issues[0];
        const event: DiagnosticEventInput = {
            kind: 'api_failures',
            platform: 'web',
            eventId: '',
            occurredAt: now,
            appVersion: version.slice(0, 32),
            payload: {
                windowStart: now,
                windowEnd: now,
                method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
                route,
                outcome: 'decode',
                status,
                keyPath,
                issueCount: Math.min(10_000, error.issues.length),
                detail: `${issue?.code ?? 'decode'}: ${issue?.message ?? 'Schema mismatch'}`.slice(
                    0,
                    300,
                ),
            },
        };
        // JSON escaping and multi-byte issue text must also fit the 2 KiB wire cap.
        const encoder = new TextEncoder();
        while (encoder.encode(JSON.stringify(event.payload)).byteLength > 2 * 1024) {
            event.payload.detail = event.payload.detail!.slice(0, -1);
        }
        seen.add(key);
        // Shared queue: batching, the per-tab rate cap and the admin opt-out.
        recordDiagnostic(`contract:${key}`, () => event);
    } catch {
        // Includes environments without browser crypto/version support.
    }
}
