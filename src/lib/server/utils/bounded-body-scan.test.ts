// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Source scan: a route or handler module that reads the request body itself
 * (`request.json()` / `.text()` / `.formData()` / `.arrayBuffer()` / `.blob()`)
 * buffers up to adapter-node's BODY_SIZE_LIMIT (50M by default). On an
 * anonymous or /j route that is a memory-exhaustion lever. Such a read must go
 * through `utils/bounded-body-reader.ts` (default 256 KB), or the module must
 * be wrapped by `mount()`/`withValidation()`, which cap the body before the
 * handler runs, or it must be on the allowlist below with the reason.
 *
 * A module that uses the bounded reader contains no direct read at all, so
 * "direct read present" is the flag.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP_ROOT = join(__dirname, '..', '..', '..', '..');
const SCAN_DIRS = ['src/routes', 'src/lib/server', 'src/lib/utils'];

/** Direct reads of an incoming request body (not a fetch() Response). */
const DIRECT_READ = /(?:\brequest|\breq|\.request)\.(?:json|text|formData|arrayBuffer|blob)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            if (entry.name === '__testkit__' || entry.name === 'external') continue;
            walk(full, out);
        } else if (
            entry.name.endsWith('.ts') &&
            !/\.(test|spec)\.ts$/.test(entry.name) &&
            !entry.name.endsWith('.d.ts')
        ) {
            out.push(full);
        }
    }
    return out;
}

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

/**
 * mount() reads the body bounded before the handler and restores it, but ONLY
 * for a def that declares a `request.body` schema (mount.ts: "streaming/upload
 * handlers (no body schema) are never buffered"). A `defineEndpoint` module
 * that reads the body itself with no body schema was uncapped, so it is not
 * "wrapped": it must use the bounded reader. `raw: true` defs bypass mount's
 * read too.
 */
function isWrapped(src: string): boolean {
    const mounted =
        /\bdefineEndpoint\(/.test(src) &&
        !/\braw:\s*true\b/.test(src) &&
        /\bbody:\s*[A-Za-z_]/.test(src);
    return mounted || /\bwithValidation\(/.test(src);
}

function directReaders(): string[] {
    const found: string[] = [];
    for (const dir of SCAN_DIRS) {
        for (const file of walk(join(APP_ROOT, dir))) {
            const src = stripComments(readFileSync(file, 'utf8'));
            if (DIRECT_READ.test(src) && !isWrapped(src)) {
                found.push(relative(APP_ROOT, file));
            }
        }
    }
    return found.sort();
}

/**
 * Authenticated or admin-only readers that keep a direct read, with the reason.
 * Nothing under /j, proprietary/, oauth/ or an anonymous endpoint belongs here.
 */
const ALLOWED: Record<string, string> = {
    'src/routes/admin/settings/appearance/+page.server.ts':
        'admin form action; /admin is gated in hooks by route id',
    'src/routes/admin/settings/audiobookshelf/+page.server.ts':
        'admin form action; /admin is gated in hooks by route id',
    'src/routes/admin/system/cost/+page.server.ts':
        'admin form action; /admin is gated in hooks by route id',
    'src/routes/admin/system/instance/+page.server.ts':
        'admin form action; /admin is gated in hooks by route id',
    'src/lib/server/admin/settings-helpers.ts':
        'admin form actions, denyUnlessAdmin() runs before the read',
    'src/lib/server/api/defs/admin/upload/[libraryPathId]/ancillary.ts':
        'admin multipart upload (raw def); size is the point of the route',
    'src/lib/server/api/defs/admin/upload/[libraryPathId]/chunks/[uploadId].ts':
        'admin chunked upload (raw def); each chunk is size-checked by the upload service',
    'src/lib/server/api/defs/admin/media/[id]/pipeline/stage-body.ts':
        'helper called only from mount()-wrapped admin defs, body already capped',
    'src/lib/utils/data-extraction.ts':
        'extractBody() is called only from mount()-wrapped defs, body already capped',
    'src/lib/server/utils/avatar-upload.ts':
        'authenticated multipart; Content-Length precheck plus post-parse size check, covered by avatar-upload.test.ts at the adapter seam',
};

/**
 * Open: a file that cannot be changed in place yet. It must move to the bounded
 * reader; remove the entry then. Empty when nothing is pending.
 */
const PENDING: Record<string, string> = {};

describe('direct request-body reads outside mount()', () => {
    const readers = directReaders();

    it('every direct reader is allowlisted with a reason or listed as pending', () => {
        const known = new Set([...Object.keys(ALLOWED), ...Object.keys(PENDING)]);
        const unexpected = readers.filter((f) => !known.has(f));
        expect(
            unexpected,
            'read the body with readBoundedJson()/readBoundedBodyText() from utils/bounded-body-reader',
        ).toEqual([]);
    });

    it('no allowlist or pending entry is stale', () => {
        const stale = [...Object.keys(ALLOWED), ...Object.keys(PENDING)].filter(
            (f) => !readers.includes(f),
        );
        expect(stale).toEqual([]);
    });

    it('every allowlist reason names who can reach the route, and only admin-gated ones may be silent', () => {
        // A route a non-admin can reach must not hide here: it gets the bounded
        // reader. The few authenticated exceptions are named, not pattern-matched.
        const authenticatedExceptions = [
            'src/lib/server/utils/avatar-upload.ts',
            'src/lib/utils/data-extraction.ts',
        ];
        const notAdmin = Object.keys(ALLOWED).filter(
            (f) => !/admin/.test(f) && !authenticatedExceptions.includes(f),
        );
        expect(notAdmin).toEqual([]);
    });

    it('the allowlist holds no /j, proprietary, oauth or anonymous entry', () => {
        const bad = Object.keys(ALLOWED).filter((f) =>
            /\/j\/|proprietary|\/oauth\/|\/auth\/|\/setup\//.test(f),
        );
        expect(bad).toEqual([]);
    });

    it('pending entries are the only open items', () => {
        expect(Object.keys(PENDING).sort()).toEqual(readers.filter((f) => f in PENDING).sort());
    });
});
