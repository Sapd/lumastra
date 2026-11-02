// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { def } from '$lib/server/api/defs/admin/plugins/external/install.js';
import { isCrossSiteFormSubmission } from '$lib/server/middleware/csrf.js';

/** Build the minimal RequestEvent shape isCrossSiteFormSubmission reads ({request,url}). */
function eventOf(request: Request): RequestEvent {
    return { request, url: new URL(request.url) } as RequestEvent;
}

describe('admin external install def', () => {
    it('is admin-gated and internal', () => {
        expect(def.auth).toEqual({ kind: 'admin' });
        expect(def.visibility).toBe('internal');
    });
    it('exposes only a POST handler', () => {
        expect(typeof def.handlers.POST).toBe('function');
        expect(def.handlers.GET).toBeUndefined();
    });
});

describe('CSRF posture on the internal BFF surface', () => {
    // The one genuinely-new browser-reachable surface. csrfHandle mirrors SvelteKit
    // and only inspects FORM content types (urlencoded/multipart/text-plain). A
    // cross-origin form POST MUST be flagged; a JSON body is blocked by CORS
    // preflight at the browser, NOT by csrfHandle, so JSON is not the code path.
    it('flags a cross-origin form POST to the install route', () => {
        const req = new Request('https://victim.example/api/admin/plugins/external/install', {
            method: 'POST',
            headers: {
                origin: 'https://evil.example',
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: 'manifestUrl=https://x/m&signature=zzz',
        });
        expect(isCrossSiteFormSubmission(eventOf(req))).toBe(true);
    });
    it('does not flag a same-origin form POST', () => {
        const req = new Request('https://victim.example/api/admin/plugins/external/install', {
            method: 'POST',
            headers: {
                origin: 'https://victim.example',
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: 'manifestUrl=https://x/m&signature=zzz',
        });
        expect(isCrossSiteFormSubmission(eventOf(req))).toBe(false);
    });
});
