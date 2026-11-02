// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Save-time validation of an admin-configured now-playing source.
 *
 * `parseRegex` refuses an unsafe pattern on every poll (security review
 * 2026-09-12, C7), but that surfaces as a per-station poll error the admin
 * only sees later. Reject the pattern when the station is SAVED, with the
 * reason, so a bad pattern never reaches the database in the first place.
 * Runs server-side only — the shared zod schema stays free of server imports.
 */

import type { ValidationDetail } from '$lib/server/api/problem.js';
import { findUnsafeRegexReason } from './parser.js';

type SourceLike =
    | {
          format?: string;
          regexPattern?: string | null;
          [key: string]: unknown;
      }
    | null
    | undefined;

const FIELD = 'metadataSource.regexPattern';

export function metadataSourceIssues(source: SourceLike): ValidationDetail[] | null {
    if (!source || source.format !== 'regex' || !source.regexPattern) return null;
    const pattern = source.regexPattern;

    try {
        new RegExp(pattern, 'u');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return [{ field: FIELD, message: `Pattern does not compile: ${message}` }];
    }

    const reason = findUnsafeRegexReason(pattern);
    if (reason) {
        return [{ field: FIELD, message: `Pattern rejected as unsafe: ${reason}` }];
    }
    return null;
}
