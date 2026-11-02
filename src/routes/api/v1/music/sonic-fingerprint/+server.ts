// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/sonic-fingerprint — mounts the SAME def as the internal
// /api/music/sonic-fingerprint route, so native clients get the rail the web
// dashboard already renders. Bearer clients can only reach /api/v1/*: the
// reverse proxy keeps every other /api/* path behind forward-auth.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/sonic-fingerprint.js';

export const { GET } = mount(def, { surface: 'v1' });
