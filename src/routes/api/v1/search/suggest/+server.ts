// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/search/suggest — lightweight typeahead on the redesign contract.
// Title-only, small {items,page} of lean media handles for as-you-type clients.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/search/suggest.js';

// Image hrefs point at the catalog image surface (/api/v1/media/...),
// matching GET /media/{id}'s images{} map.
export const { GET } = mount(def, { surface: 'v1' });
