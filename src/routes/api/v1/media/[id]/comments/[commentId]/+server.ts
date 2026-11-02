// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/v1/media/{id}/comments/{commentId}
 */
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/comments/[commentId].js';

export const { DELETE } = mount(def, { surface: 'v1' });
