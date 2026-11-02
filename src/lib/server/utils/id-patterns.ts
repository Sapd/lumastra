// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Re-exported from the client-safe module so existing server-only imports
 *  keep working. Prefer importing directly from `$lib/utils/id-patterns.js`
 *  in new code — it works from both client and server. */
export { UUID_RE, UUID_RE_LOOSE } from '$lib/utils/id-patterns.js';
