// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Helper for fetching SvelteKit page load data in Playwright API tests.
 *
 * SvelteKit serialises `+page.server.ts` load data using the devalue format and
 * serves it at `/<route>/__data.json` (a PATH suffix, not a query param).  The
 * response envelope looks like:
 *
 *   { "type": "data", "nodes": [ <layout-node>, <leaf-node> ] }
 *
 * where each node is either null or `{ "type": "data", "data": <devalue-array> }`.
 *
 * This helper:
 *   1. Builds the correct `/__data.json` URL from any route path + optional query string.
 *   2. GETs the endpoint and asserts 2xx.
 *   3. Picks the LAST node that carries `type==="data" && data`, i.e. the leaf
 *      `+page` node (not the layout).
 *   4. Rehydrates it with `devalue.unflatten` and returns the plain JS object.
 */

import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { unflatten } from 'devalue';

/**
 * Fetch the SvelteKit `__data.json` endpoint for `routePath` and return the
 * rehydrated leaf-page load data object.
 *
 * @param request  Playwright `APIRequestContext` (the `request` fixture).
 * @param routePath  The SvelteKit route, e.g. `/library/training` or
 *                   `/library/training/some-uuid`.  May include a query string:
 *                   `/library/training?limit=10&offset=5`.  Must NOT already end
 *                   with `/__data.json`.
 * @returns  The fully rehydrated page-data object returned by `+page.server.ts`.
 */
export async function fetchPageData(
    request: APIRequestContext,
    routePath: string,
): Promise<Record<string, unknown>> {
    // Split path from query string
    const qIdx = routePath.indexOf('?');
    const path = qIdx === -1 ? routePath : routePath.slice(0, qIdx);
    const qs = qIdx === -1 ? '' : routePath.slice(qIdx); // includes leading '?'

    // Build the __data.json URL: /<path>/__data.json[?<qs>]
    const dataUrl = `${path.replace(/\/$/, '')}/__data.json${qs}`;

    const r = await request.get(dataUrl);
    expect(r.ok(), `fetchPageData: GET ${dataUrl} returned ${r.status()}`).toBe(true);

    // A route that streams promises from its load (e.g. `/music`) does NOT
    // return one JSON document: SvelteKit writes the envelope, then a newline,
    // then one chunk per promise as it resolves. `r.json()` throws
    // "Unexpected non-whitespace character after JSON" on those, which reads
    // like a broken endpoint rather than a streamed one. The envelope — which
    // carries every non-streamed key, and is all this helper returns — is
    // always the first line, so fall back to it.
    const raw = await r.text();
    let json: {
        type: string;
        nodes: Array<null | { type: string; data: unknown[] }>;
    };
    try {
        json = JSON.parse(raw);
    } catch {
        json = JSON.parse(raw.split('\n', 1)[0]);
    }

    // Find the last node with type==="data" and a non-empty data array (the leaf page node)
    const leafNode = [...json.nodes]
        .reverse()
        .find(
            (n): n is { type: string; data: unknown[] } =>
                n !== null && n.type === 'data' && Array.isArray(n.data),
        );

    if (!leafNode) {
        throw new Error(`fetchPageData: no leaf data node found in ${dataUrl} response`);
    }

    // Streamed keys arrive as `Promise` placeholders that devalue cannot revive
    // without a reviver, and it throws "Unknown type Promise" for the whole
    // document — taking the settled keys down with the unsettled ones. This
    // helper only ever returns the envelope, so resolve them to `undefined`:
    // a streamed key reads as absent rather than blowing up its siblings.
    return unflatten(leafNode.data, {
        Promise: () => undefined,
    }) as Record<string, unknown>;
}
