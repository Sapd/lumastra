// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library/validate-path.ts
 *
 * POST /api/admin/library/validate-path
 *
 * Admin-only: check a library folder path BEFORE it's saved so a wrong /
 * unmounted / unreadable / empty path doesn't silently save "successfully"
 * and then never scan. Runs server-side so it sees exactly the filesystem
 * the scanner sees (the in-container path).
 *
 * Returns: { exists, isDirectory, readable, isEmpty }
 *   - exists=false       → path doesn't exist (typo, or not mounted in container)
 *   - isDirectory=false  → it's a file, not a folder
 *   - readable=false     → permission denied for the container user
 *   - isEmpty=true       → readable directory with no entries (nothing to scan yet)
 *
 * Admins already control library paths and the filesystem, so stat'ing an
 * arbitrary path confers no new capability. The directory read is bounded.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response: bare object { exists, isDirectory, readable, isEmpty }
 * 422 validation_failed on missing / relative / too-long path.
 */

import { opendir, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { isWithinAllowedLibraryRoots } from '$lib/server/services/library-root-validation.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        body: z.object({
            path: z.string().min(1).max(4096),
        }),
    },
    handlers: {
        POST: async (_event, ctx) => {
            const path = ctx.input!.body.path.trim();

            if (!path) {
                return ApiProblem.validationFailed('A folder path is required');
            }
            if (!isAbsolute(path)) {
                return ApiProblem.validationFailed(
                    'Library folder paths must be absolute (e.g. /media/movies).',
                );
            }

            // With LIBRARY_ALLOWED_ROOTS set, a folder outside it cannot become a
            // library — and this check must not answer "exists?" for it either.
            if (!(await isWithinAllowedLibraryRoots(path))) {
                return ApiProblem.validationFailed(
                    'This folder is outside the folders this server allows for libraries (LIBRARY_ALLOWED_ROOTS).',
                );
            }

            let info: { isDirectory(): boolean };
            try {
                info = await stat(path);
            } catch {
                return json({ exists: false, isDirectory: false, readable: false, isEmpty: false });
            }

            if (!info.isDirectory()) {
                return json({ exists: true, isDirectory: false, readable: false, isEmpty: false });
            }

            // Bounded read: we only need to know whether there's at least one entry.
            let readable = true;
            let isEmpty = false;
            try {
                const dir = await opendir(path);
                try {
                    isEmpty = (await dir.read()) === null;
                } finally {
                    await dir.close();
                }
            } catch {
                readable = false;
            }

            return json({ exists: true, isDirectory: true, readable, isEmpty });
        },
    },
});
