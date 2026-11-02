// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/media/{id}/files — physical files for a media item (media:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/media/[id]/files-admin.ts (named `files-admin` — NOT
// `files` — to avoid colliding with the unrelated, already-generator-mounted
// editions def at defs/media/[id]/files.ts; see that file's docstring), which
// delegates to the internal admin read handler. Stays hand-written
// (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/files-admin.js';

export const { GET } = mount(def, { surface: 'v1' });
