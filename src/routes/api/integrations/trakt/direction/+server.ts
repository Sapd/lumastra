// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { traktDirectionDef } from '$lib/server/api/defs/integrations/trakt/direction.js';

export const { GET, PUT } = mount(traktDirectionDef, {
    surface: 'internal',
});
