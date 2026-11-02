// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Public API route for finding similar media - accessible via Bearer token.
// Mounts the shared def on the v1 surface. The handler derives every image URL
// from ctx.surface, so this mount emits /api/v1/media/... hrefs.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id-similar.js';

export const { GET } = mount(def, { surface: 'v1' });
