// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
export type HealthView = 'overview' | 'diagnostics' | 'history' | 'cluster';

const anchors: Record<string, HealthView> = {
    findings: 'overview',
    components: 'diagnostics',
    dependencies: 'diagnostics',
    providers: 'diagnostics',
    files: 'diagnostics',
    security: 'diagnostics',
    activity: 'history',
    trends: 'history',
};

/** Legacy section links take precedence so a saved view cannot hide the target. */
export function healthView(url: URL): HealthView {
    const id = url.hash.slice(1);
    const anchor = Object.hasOwn(anchors, id) ? anchors[id] : undefined;
    if (anchor) return anchor;
    if (url.searchParams.get('tab') === 'cluster') return 'cluster';
    const view = url.searchParams.get('view');
    return view === 'diagnostics' || view === 'history' ? view : 'overview';
}

export function healthViewUrl(current: URL, view: string): URL {
    const url = new URL(current);
    url.hash = '';
    url.searchParams.delete('tab');
    url.searchParams.delete('view');
    if (view === 'cluster') url.searchParams.set('tab', 'cluster');
    else if (view === 'diagnostics' || view === 'history') url.searchParams.set('view', view);
    return url;
}

interface HealthAttention {
    verdict: 'healthy' | 'degraded' | 'critical';
    attention: {
        unavailable?: boolean;
        items: ReadonlyArray<{ acked?: boolean; snoozed?: boolean }>;
    };
}

/** Preserve the server's severity semantics; informational items aren't outages. */
export function healthSummary(
    payload: HealthAttention | null,
    failed: boolean,
): {
    verdict: 'healthy' | 'degraded' | 'critical' | 'unknown';
    count: number | undefined;
} {
    const count =
        payload && !payload.attention.unavailable
            ? payload.attention.items.filter((item) => !item.acked && !item.snoozed).length
            : undefined;
    return {
        verdict: !payload || failed || payload.attention.unavailable ? 'unknown' : payload.verdict,
        count,
    };
}

/**
 * The per-component health entries the page lists and counts towards its
 * verdict, from a /api/health/components report.
 *
 * `valkeyCapacity` normally renders as its own per-instance block, so it is
 * left out here — unless the probe itself failed: then it carries no
 * `instances`, only a status and error, and must stay a component so the
 * failure is shown and counted instead of vanishing from both places.
 */
export function healthComponentEntries(
    report: Record<string, unknown> | null,
): { name: string; data: unknown }[] {
    if (!report) return [];
    return Object.entries(report)
        .filter(
            ([k, v]) =>
                k !== 'timestamp' &&
                !(
                    k === 'valkeyCapacity' &&
                    Array.isArray((v as { instances?: unknown } | undefined)?.instances)
                ),
        )
        .map(([name, data]) => ({ name, data }));
}
