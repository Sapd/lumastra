// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET|HEAD /api/v1/media/{id}/topshelf-preview/file/{variant}.mp4
 *
 * Serves the tvOS Top Shelf preview/cinemagraph MP4 bytes. Public route —
 * the `?sig=` HMAC is the entire credential (see the def for the full
 * sig-or-403 contract). Declared `auth:'public'` in the def; the hooks.server.ts
 * app-layer backstop is scoped to allow ONLY this `/file/` sub-path through
 * unauthenticated (the mint endpoint above stays behind real auth).
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/topshelf-preview/file/[variant].js';

export const { GET, HEAD } = mount(def, { surface: 'v1' });
