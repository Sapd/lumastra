// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// health-taxonomy.ts — client-safe taxonomy display helpers (Slice 1).
//
// Re-exports the pure mapping helpers from the schema (single source of truth)
// and adds `taxonomyBadge()` so every admin surface — system-health, cluster,
// ingest — uses identical dot colours, labels, and wording. This kills the
// three divergent colour-pickers the audit flagged.

import type { HealthTaxonomy } from '$lib/schemas/task-system-health.schema.js';

export {
    taxonomyFromFinding,
    taxonomyFromCluster,
    taxonomyFromComponentStatus,
    type HealthTaxonomy,
    type ClusterTaxonomyInput,
} from '$lib/schemas/task-system-health.schema.js';

export interface TaxonomyBadge {
    /** Uppercase label, e.g. "HEALTHY". */
    label: string;
    /** Tailwind class for a status dot's background. */
    dotClass: string;
    /** Tailwind classes for a pill (bg + text). */
    pillClass: string;
    /** Tailwind text colour class. */
    textClass: string;
}

const BADGES: Record<HealthTaxonomy, TaxonomyBadge> = {
    healthy: {
        label: 'HEALTHY',
        dotClass: 'bg-green-400',
        pillClass: 'bg-green-900/50 text-green-300',
        textClass: 'text-green-300',
    },
    degraded: {
        label: 'DEGRADED',
        dotClass: 'bg-amber-400',
        pillClass: 'bg-amber-900/50 text-amber-300',
        textClass: 'text-amber-300',
    },
    unhealthy: {
        label: 'UNHEALTHY',
        dotClass: 'bg-red-400',
        pillClass: 'bg-red-900/50 text-red-300',
        textClass: 'text-red-300',
    },
    unknown: {
        label: 'UNKNOWN',
        dotClass: 'bg-surface-600',
        pillClass: 'bg-surface-700 text-surface-400',
        textClass: 'text-surface-400',
    },
};

/** Consistent dot colour / label / pill classes for a taxonomy state. */
export function taxonomyBadge(status: HealthTaxonomy): TaxonomyBadge {
    return BADGES[status] ?? BADGES.unknown;
}
