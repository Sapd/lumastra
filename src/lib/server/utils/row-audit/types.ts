// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Row-audit invariants — the reusable pattern across all algorithmic rows.
 *
 * An "invariant" is a declarative assertion: something that must be true of
 * any item the row presents to a user. When an invariant fails, the item is
 * a bug-in-waiting (stale data, wrong ranking input, drifted sync state, etc).
 *
 * Start with one row type (continue-watching). Generalize once a second row
 * needs the same pattern.
 */

export interface RowInvariant<T> {
    /** Stable machine identifier (for metrics/logs). */
    id: string;
    /** Human-readable one-liner shown in admin audit output. */
    description: string;
    /** Returns true if the item satisfies the invariant. */
    check: (item: T) => boolean;
}

export interface InvariantViolation {
    invariantId: string;
    description: string;
}

export interface AuditResult<T> {
    item: T;
    violations: InvariantViolation[];
}

export function runInvariants<T>(
    items: T[],
    invariants: readonly RowInvariant<T>[],
): AuditResult<T>[] {
    return items.map((item) => {
        const violations: InvariantViolation[] = [];
        for (const inv of invariants) {
            if (!inv.check(item)) {
                violations.push({
                    invariantId: inv.id,
                    description: inv.description,
                });
            }
        }
        return { item, violations };
    });
}

export interface AuditSummary {
    total: number;
    healthy: number;
    violating: number;
    byInvariant: Record<string, number>;
}

export function summarizeAudit<T>(results: AuditResult<T>[]): AuditSummary {
    const summary: AuditSummary = {
        total: results.length,
        healthy: 0,
        violating: 0,
        byInvariant: {},
    };
    for (const r of results) {
        if (r.violations.length === 0) {
            summary.healthy++;
        } else {
            summary.violating++;
            for (const v of r.violations) {
                summary.byInvariant[v.invariantId] = (summary.byInvariant[v.invariantId] ?? 0) + 1;
            }
        }
    }
    return summary;
}
