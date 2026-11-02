// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/text-search — text-to-sound semantic search on the
// redesign contract ({items,page} of self-describing track handles).
// Image hrefs point at the catalog image surface (/api/v1/media/...).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/text-search.js';

export const { GET } = mount(def, { surface: 'v1' });
