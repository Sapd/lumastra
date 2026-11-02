// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/network/speed-test/results
 *
 * Stores the timings a client measured for itself. Rate-limited to 6
 * requests/min per user; retained for 90 days.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/network/speed-test-results.js';

export const { POST } = mount(def, { surface: 'v1' });
