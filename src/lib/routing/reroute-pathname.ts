// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { deLocalizeUrl } from '$lib/paraglide/runtime.js';
import { JELLYFIN_ROUTE_PATTERNS } from './jellyfin-route-patterns.js';

/** One level of the /j route tree, built from the generated pattern table. */
interface RouteNode {
    /** Static children by lower-cased segment, holding the canonical spelling. */
    statics: Map<string, { canonical: string; node: RouteNode }>;
    /** Segments mixing text and a param, e.g. `stream.[container]`. */
    mixed: { re: RegExp; parts: string[]; node: RouteNode }[];
    param?: RouteNode;
    rest: boolean;
    terminal: boolean;
}

const newNode = (): RouteNode => ({ statics: new Map(), mixed: [], rest: false, terminal: false });

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildTree(patterns: readonly string[]): RouteNode {
    const root = newNode();
    for (const pattern of patterns) {
        let node = root;
        for (const seg of pattern.split('/').filter(Boolean)) {
            if (seg.startsWith('[...')) {
                node.rest = true;
                node = newNode();
                break;
            }
            if (/^\[[^\]]+\]$/.test(seg)) {
                node = node.param ??= newNode();
            } else if (seg.includes('[')) {
                // Literal pieces at even indexes, params at odd ones.
                const parts = seg.split(/\[[^\]]+\]/);
                const re = new RegExp('^' + parts.map(escapeRe).join('(.+?)') + '$', 'i');
                let entry = node.mixed.find((m) => m.re.source === re.source);
                if (!entry) node.mixed.push((entry = { re, parts, node: newNode() }));
                node = entry.node;
            } else {
                const key = seg.toLowerCase();
                let entry = node.statics.get(key);
                if (!entry) node.statics.set(key, (entry = { canonical: seg, node: newNode() }));
                node = entry.node;
            }
        }
        node.terminal = true;
    }
    return root;
}

let jellyfinTree: RouteNode | undefined;

/**
 * Rewrite the static segments of `segs` to the casing of the /j route they
 * reach, the way SvelteKit would pick it (static before mixed before param
 * before rest). Param values are returned untouched. `null` = no route.
 */
function canonicalize(node: RouteNode, segs: string[], i: number): string[] | null {
    if (i === segs.length) return node.terminal ? [] : node.rest ? [] : null;
    const seg = segs[i];
    const st = node.statics.get(seg.toLowerCase());
    if (st) {
        const tail = canonicalize(st.node, segs, i + 1);
        if (tail) return [st.canonical, ...tail];
    }
    for (const m of node.mixed) {
        const hit = m.re.exec(seg);
        if (!hit) continue;
        const tail = canonicalize(m.node, segs, i + 1);
        if (tail) {
            const fixed = m.parts.map((lit, k) => (k === 0 ? lit : hit[k] + lit)).join('');
            return [fixed, ...tail];
        }
    }
    if (node.param) {
        const tail = canonicalize(node.param, segs, i + 1);
        if (tail) return [seg, ...tail];
    }
    if (node.rest) return segs.slice(i);
    return null;
}

/**
 * The /j path with each static segment in its route's casing. Jellyfin's
 * routing is case-insensitive and apps rely on it (Finamp's
 * `/Audio/{id}/Universal`, Findroid TV's `/users/{id}/Images/Primary`,
 * jellyfin_apiclient_python's `/system/info/public`); SvelteKit's is not.
 * A path no route matches is returned unchanged (it 404s either way).
 */
export function canonicalJellyfinPath(path: string, patterns = JELLYFIN_ROUTE_PATTERNS): string {
    const tree =
        patterns === JELLYFIN_ROUTE_PATTERNS
            ? (jellyfinTree ??= buildTree(JELLYFIN_ROUTE_PATTERNS))
            : buildTree(patterns);
    const segs = path.slice('/j/'.length).split('/');
    const fixed = canonicalize(tree, segs, 0);
    return fixed ? '/j/' + fixed.join('/') : path;
}

let imageTypeRegexes: RegExp[] | undefined;

/** Does this canonical path reach an `.../Images/[imageType]` route? */
function isImageTypeRoute(path: string): boolean {
    imageTypeRegexes ??= JELLYFIN_ROUTE_PATTERNS.filter((p) =>
        p.endsWith('/Images/[imageType]'),
    ).map(
        (p) =>
            new RegExp(
                '^/j' +
                    p
                        .split('/')
                        .map((seg) => (/^\[[^\]]+\]$/.test(seg) ? '[^/]+' : escapeRe(seg)))
                        .join('/') +
                    '$',
            ),
    );
    return imageTypeRegexes.some((r) => r.test(path));
}

/**
 * The pathname SvelteKit matches routes against, before decoding and base
 * stripping — the body of the `reroute` hook in `src/hooks.ts`.
 *
 * Lives here so server code can classify a request by the route it will reach
 * (`$lib/server/auth/routed-pathname.ts`): resolveAuth deciding on the raw
 * pathname let `/de/api/v1/…` and `/api/%76%31/…` reach /api/v1 handlers
 * through the forward-auth branch.
 */
export function reroutePathname(url: URL): string {
    // Jellyfin clients build URLs in subtly different ways. Our /j compat routes
    // are case-sensitive (SvelteKit on Linux) and single-leaf, so normalize the
    // quirks here before route matching rather than duplicating routes.
    if (url.pathname.startsWith('/j/')) {
        // Jellyfin image URLs may carry a trailing image index
        // (/Images/Backdrop/0, /Users/{id}/Images/Primary/0). We serve one
        // asset per type, so drop the index so the [imageType] leaf route
        // matches. Scoped to /j by the guard above.
        // Only at real `Images/[imageType]` route positions, after canonicalising:
        // `/j/web/images/a/1` (rest param) must stay as sent.
        const slash = url.pathname.length > 3 && url.pathname.endsWith('/');
        const path = slash ? url.pathname.slice(0, -1) : url.pathname;
        // `Images/Chapter/{n}` is its own authenticated route (the index selects the
        // chapter), not an image type with a redundant index: never strip it.
        const m = /^(.*\/images\/(?!chapter\/)[^/]+)\/\d+$/i.exec(path);
        const stripped = m ? canonicalJellyfinPath(m[1]) : null;
        const out = stripped && isImageTypeRoute(stripped) ? stripped : canonicalJellyfinPath(path);
        return slash ? out + '/' : out;
    }
    return deLocalizeUrl(url).pathname;
}
