// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/v1/playlists/{id}/comments/{commentId}
 */
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/[id]/comments/[commentId].js';

export const { DELETE } = mount(def, { surface: 'v1' });
