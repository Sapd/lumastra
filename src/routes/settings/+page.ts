// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageLoad } from './$types';

// On desktop the layout renders the sidebar + first section; on mobile the
// root shows the section LIST. We no longer hard-redirect here so the phone
// list has a stable home. (Desktop "first section" selection is done in the
// layout via a client redirect when the viewport is >= lg — see +layout.svelte.)
export const load: PageLoad = async () => {
    return { isSettingsRoot: true };
};
