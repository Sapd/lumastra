// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/POST /api/v1/playlists
 *
 * {items,page} collection envelope. No silent public→private downgrade on create (403 instead).
 */
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
