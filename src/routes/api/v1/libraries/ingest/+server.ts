// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/libraries/ingest — canonical path (renamed from /api/v1/library/ingest)
//
// Hand-mounts the SAME def as the legacy singular alias so both URLs stay
// documented (def.docs) and behave identically. Phase 3.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/library/ingest.js';

export const { POST } = mount(def, { surface: 'v1' });
