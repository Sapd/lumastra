// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveSourceUri } from '$lib/server/utils/library-path-safety.js';
import type { z } from 'zod';
import type { LibraryIngestRequestSchema } from '$lib/schemas/api-v1.js';

type Body = z.infer<typeof LibraryIngestRequestSchema>;
type Root = { id: string; sourcePrefix: string | null };
export type NormalizeResult =
    | { ok: true; libraryPathId: string; upsert: string[]; remove: string[] }
    | { ok: false; status: 400; message: string };

export function normalizeDelta(body: Body, roots: Root[]): NormalizeResult {
    const upsert = new Set<string>(),
        remove = new Set<string>();
    let libraryPathId: string | undefined = body.libraryPathId;
    for (const c of body.changes) {
        let pathId = libraryPathId,
            rel: string;
        if (c.sourceUri) {
            const res = resolveSourceUri(c.sourceUri, roots);
            if (!res)
                return {
                    ok: false,
                    status: 400,
                    message: `sourceUri matches no library source_prefix: ${c.sourceUri}`,
                };
            if (pathId && pathId !== res.libraryPathId)
                return {
                    ok: false,
                    status: 400,
                    message: 'all changes must resolve to one libraryPathId — split per library',
                };
            pathId = res.libraryPathId;
            rel = res.rel;
        } else {
            if (!libraryPathId)
                return {
                    ok: false,
                    status: 400,
                    message: 'libraryPathId is required when entries use path',
                };
            rel = c.path!;
        }
        if (!libraryPathId) libraryPathId = pathId;
        // Belt-and-suspenders traversal guard — canonical enforcement is in
        // library-path-safety.ts resolveUnderRoot; this gives a clean 400 at the boundary
        // before the entry is ever enqueued.
        if (
            !rel ||
            rel.startsWith('/') ||
            rel.includes('\\') ||
            rel.split('/').some((s) => s === '..' || s === '')
        ) {
            return {
                ok: false,
                status: 400,
                message: `path contains an invalid or traversal sequence: ${rel}`,
            };
        }
        (c.op === 'upsert' ? upsert : remove).add(rel);
    }
    if (!libraryPathId)
        return { ok: false, status: 400, message: 'could not determine libraryPathId' };
    for (const p of upsert)
        if (remove.has(p))
            return { ok: false, status: 400, message: `path in both upsert and remove: ${p}` };
    return { ok: true, libraryPathId, upsert: [...upsert], remove: [...remove] };
}
