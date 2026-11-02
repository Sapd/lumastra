// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

// Catch-all 404 handler for unmatched /api/v1/* paths. It exports a
// SvelteKit `fallback` handler (not a specific HTTP method), so there is no
// concrete operation to document — this empty metadata satisfies the
// coverage gate without emitting a misleading path into the spec.
export const route: RouteMetadata = {};
