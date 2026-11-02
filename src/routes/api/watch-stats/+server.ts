// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/watch-stats — SPA-internal surface mount.
 * GET → { stats, day? }  (bare object — no legacy success wrapper)
 * Errors: problem+json (incl. 503 dependency_unavailable).
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-stats/index.js';

export const { GET } = mount(def, { surface: 'internal' });
