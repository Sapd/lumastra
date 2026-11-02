// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/media/{id}/topshelf-preview
 *
 * Mint signed URLs for the tvOS Top Shelf carousel's preview + cinemagraph
 * MP4s. Auth: authenticated user (Bearer, PAT, session).
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/topshelf-preview/index.js';

export const { GET } = mount(def, { surface: 'v1' });
