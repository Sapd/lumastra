// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `x-required-grant`: the mintable PAT / service-token grant an operation needs,
 * computed from the def's RUNTIME `auth` spec so the published spec cannot drift
 * from the gate.
 *
 * Fine-grained gate names (`tokens:admin`, `library:admin`, ...) are internal and
 * not mintable. A third party needs the smallest coarse grant whose
 * `expandScopes` expansion covers one of them.
 */
import { expandScopes } from '../../src/lib/server/api/principal';

export type RequiredGrant = 'read' | 'write' | 'admin' | 'integrations:read' | 'diagnostics:read';

/** Grants outside the read < write < admin ladder, each reaching only its own endpoints. */
const OWN_ENDPOINT_GRANTS: readonly RequiredGrant[] = ['integrations:read', 'diagnostics:read'];

const COARSE_ORDER = ['read', 'write', 'admin'] as const;
type CoarseGrant = (typeof COARSE_ORDER)[number];
const RANK: Record<CoarseGrant, number> = { read: 1, write: 2, admin: 3 };

/**
 * `integrations:read` and `diagnostics:read` are not on the read < write <
 * admin ladder: each reaches only its own endpoints. A combinator that mixes
 * one with any other grant therefore has no single answer.
 */
function combine(
    grants: readonly RequiredGrant[],
    pick: 'strongest' | 'weakest',
): RequiredGrant | undefined {
    if (grants.length === 0) return undefined;
    for (const own of OWN_ENDPOINT_GRANTS) {
        if (grants.includes(own)) return grants.every((g) => g === own) ? own : undefined;
    }
    const sorted = [...(grants as CoarseGrant[])].sort((a, b) =>
        pick === 'strongest' ? RANK[b] - RANK[a] : RANK[a] - RANK[b],
    );
    return sorted[0];
}

function isMutation(httpMethod: string): boolean {
    const m = httpMethod.toUpperCase();
    return m !== 'GET' && m !== 'HEAD';
}

/** v1ScopeMethodDenial: a non-GET/HEAD request needs `write` or `admin`. */
function clampToMethod(grant: RequiredGrant, httpMethod: string): RequiredGrant {
    return grant === 'read' && isMutation(httpMethod) ? 'write' : grant;
}

function grantForScopes(anyOf: readonly string[]): RequiredGrant | undefined {
    for (const own of OWN_ENDPOINT_GRANTS) if (anyOf.includes(own)) return own;
    for (const grant of COARSE_ORDER) {
        const expanded = expandScopes([grant]);
        if (anyOf.some((s) => expanded.includes(s))) return grant;
    }
    return undefined;
}

/**
 * The grant a PAT or service token needs for `spec` on `httpMethod`, or
 * undefined when the spec requires no credential (or is not expressible as a
 * grant).
 */
export function requiredGrantForAuth(spec: unknown, httpMethod: string): RequiredGrant | undefined {
    if (!spec || typeof spec !== 'object') return undefined;
    const s = spec as { kind?: unknown; anyOf?: unknown; then?: unknown; specs?: unknown };
    switch (s.kind) {
        case 'user':
        case 'selfOrAdmin':
            // selfOrAdmin: the self path needs only the signed-in user's grant.
            return clampToMethod('read', httpMethod);
        case 'admin':
            return 'admin';
        case 'scope': {
            const g = grantForScopes(Array.isArray(s.anyOf) ? (s.anyOf as string[]) : []);
            // These grants are GET/HEAD-only; a mutation gated on one is not
            // reachable with any mintable grant.
            if (g && OWN_ENDPOINT_GRANTS.includes(g) && isMutation(httpMethod)) return undefined;
            return g ? clampToMethod(g, httpMethod) : undefined;
        }
        case 'feature':
            return requiredGrantForAuth(s.then, httpMethod);
        case 'all': {
            // Every gate must pass: the strongest grant wins.
            const grants = (Array.isArray(s.specs) ? s.specs : [])
                .map((x) => requiredGrantForAuth(x, httpMethod))
                .filter((g): g is RequiredGrant => g !== undefined);
            return combine(grants, 'strongest');
        }
        case 'any': {
            // Any one gate may pass: the weakest grant suffices, but only if
            // every alternative is grant-expressible.
            const specs = Array.isArray(s.specs) ? s.specs : [];
            const grants = specs.map((x) => requiredGrantForAuth(x, httpMethod));
            if (grants.length === 0 || grants.some((g) => g === undefined)) return undefined;
            return combine(grants as RequiredGrant[], 'weakest');
        }
        default:
            // 'public' and anything unknown: no extension.
            return undefined;
    }
}
