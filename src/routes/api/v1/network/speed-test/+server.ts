// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/network/speed-test
 *
 * Incompressible payload for the client to time its own download. Records
 * nothing server-side; rate-limited to 6 requests/min per user.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/network/speed-test.js';

export const { GET } = mount(def, { surface: 'v1' });
