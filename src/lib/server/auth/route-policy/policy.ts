// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The route policy table: which kind of principal may reach a route at all.
 *
 * Keyed on SvelteKit's `event.route.id` — resolved before `handle`, after
 * `reroute()`, from the decoded, base-stripped path — so `/%61dmin/…`,
 * `/de/api/v1/…`, `__data.json` with any invalidation mask and a form action
 * all land on the same row. Object-level checks (this title, this playlist)
 * stay in handlers.
 *
 * Step 1 only LOOKS UP policies (shadow mode, `shadow.ts`); nothing here
 * answers a request.
 */

export type TokenSurface =
    | 'j'
    | 'subsonic'
    | 'oauth'
    | 'metrics'
    | 'webhook'
    | 'signed'
    | 'stream'
    | 'plugin-auth'
    | 'oidc-backchannel';

/**
 * - `public`: anyone; identity attached when presented, never required.
 * - `user`: any principal the surface accepts.
 * - `admin`: an admin principal; no token opens it (`/admin/**`).
 * - `admin-scoped`: an admin principal, or a Bearer token whose decision is
 *   deferred to the route's own scope check, as today (`/api/admin/**`,
 *   `/api/v1/admin/**`, admin rows called by scoped tokens).
 * - `token-surface:<x>`: hooks never decide; the route authenticates itself.
 */
export type RoutePolicy =
    'public' | 'user' | 'admin' | 'admin-scoped' | `token-surface:${TokenSurface}`;

export const POLICY_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type PolicyMethod = (typeof POLICY_METHODS)[number];

export interface RouteRule {
    /**
     * Normalised route-id pattern (see `normalizeRouteId`). `X` matches
     * exactly; `X/**` matches X and everything below it on segment
     * boundaries; `*` matches exactly one segment.
     */
    pattern: string;
    /** One policy, or one per method with an optional `'*'` default. */
    policy: RoutePolicy | Partial<Record<PolicyMethod | '*', RoutePolicy>>;
    /** Why — required for `public` and `token-surface:*` rows. */
    reason?: string;
    /**
     * `token-surface:*` rows: symbols one of which every matched route file
     * (or the module it re-exports) must reference. Checked statically by
     * route-policy.test.ts — the only check that sees a forgotten authenticator,
     * because a token-surface row allows in every case.
     */
    authenticators?: readonly string[];
    /** Required when a change makes a route's policy looser than the snapshot. */
    loosens?: string;
}

/**
 * `/admin/(private)/courses/[id=uuid]` → `/admin/courses/[]`: route groups
 * dropped, param names erased (`[x]`/`[x=m]` → `[]`, `[...x]` → `[...]`,
 * `[[x]]` → `[[]]`) so renaming a param can never move a route to another rule.
 */
export function normalizeRouteId(id: string): string {
    const out = id
        .replace(/\/\([^/)]+\)/g, '')
        .replace(/\[\[\.\.\.[^\]]+\]\]/g, '[[...]]')
        .replace(/\[\[(?!\.\.\.\]\])[^\]]+\]\]/g, '[[]]')
        .replace(/\[\.\.\.[^\]]+\]/g, '[...]')
        .replace(/\[(?!\]|\.\.\.\]|\[)[^\]]+\]/g, '[]');
    return out || '/';
}

/** True for a route id inside an `(private)` group — never matched by the AGPL rules. */
export function isPrivateRouteId(id: string): boolean {
    return /\/\(private\)(\/|$)/.test(id);
}

interface CompiledRule {
    rule: RouteRule;
    segments: string[];
    subtree: boolean;
    literals: number;
}

function compile(rule: RouteRule): CompiledRule {
    const subtree = rule.pattern.endsWith('/**');
    const base = subtree ? rule.pattern.slice(0, -3) : rule.pattern;
    const segments = base.split('/').filter(Boolean);
    return {
        rule,
        segments,
        subtree,
        literals: segments.filter((s) => s !== '*').length,
    };
}

function matches(c: CompiledRule, idSegments: string[]): boolean {
    if (
        c.subtree ? idSegments.length < c.segments.length : idSegments.length !== c.segments.length
    ) {
        return false;
    }
    return c.segments.every((s, i) => s === '*' || s === idSegments[i]);
}

export interface RuleMatch {
    rule: RouteRule;
    /** Another rule tied with this one — a table error the coverage test rejects. */
    tie?: RouteRule;
}

export interface PolicyTable {
    match(routeId: string): RuleMatch | null;
    rules: readonly RouteRule[];
}

/**
 * Build a matcher. Precedence: more literal segments wins; on a tie an exact
 * pattern beats a subtree one; anything still tied is reported as `tie`.
 */
export function createPolicyTable(rules: readonly RouteRule[]): PolicyTable {
    const compiled = rules.map(compile);
    const cache = new Map<string, RuleMatch | null>();
    return {
        rules,
        match(routeId: string): RuleMatch | null {
            const key = normalizeRouteId(routeId);
            const hit = cache.get(key);
            if (hit !== undefined) return hit;
            const idSegments = key.split('/').filter(Boolean);
            let best: CompiledRule | null = null;
            let tie: CompiledRule | null = null;
            for (const c of compiled) {
                if (!matches(c, idSegments)) continue;
                if (!best) {
                    best = c;
                    continue;
                }
                const cmp =
                    c.literals - best.literals || (best.subtree ? 1 : 0) - (c.subtree ? 1 : 0);
                if (cmp > 0) {
                    best = c;
                    tie = null;
                } else if (cmp === 0) {
                    tie = c;
                }
            }
            const result: RuleMatch | null = best
                ? { rule: best.rule, ...(tie ? { tie: tie.rule } : {}) }
                : null;
            if (cache.size < 5000) cache.set(key, result);
            return result;
        },
    };
}

const STRICTNESS: Record<string, number> = {
    public: 0,
    'token-surface': 0,
    user: 1,
    'admin-scoped': 2,
    admin: 3,
};

/** public / token-surface 0 < user 1 < admin-scoped 2 < admin 3. */
export function strictness(policy: RoutePolicy): number {
    return STRICTNESS[policy.split(':')[0]] ?? 3;
}

/**
 * The policy a rule assigns to one method: the method's own entry, HEAD falls
 * back to GET, then the `'*'` entry, then the strictest entry of the rule
 * (SvelteKit answers 405 for a method the route does not export).
 */
export function policyForMethod(rule: RouteRule, method: string): RoutePolicy {
    const p = rule.policy;
    if (typeof p === 'string') return p;
    // Own keys only: a method token like `constructor` must not hit the prototype.
    const own = Object.hasOwn(p, method) ? p[method as PolicyMethod] : undefined;
    if (own) return own;
    if (method === 'HEAD' && p.GET) return p.GET;
    if (p['*']) return p['*'];
    const all = Object.values(p) as RoutePolicy[];
    return all.reduce((a, b) => (strictness(b) > strictness(a) ? b : a));
}
