// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createSettingsPageServer } from '$lib/server/admin/settings-helpers';

// `deviceAuth` (Public API & Device Auth) moved to the Access page and
// `topshelf` to Media & images. `downloads` joined from the Providers page,
// where original-file downloads and stream speed limits sat among metadata
// provider connections. `watchTogether` stays: the Plugins & features page is a
// plugin manager, not a settings form, and cannot render a config section.
const { load, actions } = createSettingsPageServer([
    'player',
    'streaming',
    'downloads',
    'ffmpeg',
    'ffmpeg-hardware',
    'watchTogether',
]);
export { load, actions };
