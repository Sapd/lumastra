// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/search — public catalog search on the redesign contract.
// Hand-mounted (NOT generator-owned): importing the def here makes the route
// generator treat this def as hand-mounted and skip emitting routes for it,
// leaving the legacy bespoke /api/search handler untouched.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/search/search.js';

// Image hrefs in results point at the catalog image surface (/api/v1/media/...),
// matching GET /media/{id}'s images{} map.
export const { GET } = mount(def, { surface: 'v1' });
