// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Bare /j/web — re-exports the catch-all handler so /j/web (no path) and
// /j/web/index.html, /j/web/anything-else all serve the same redirect HTML.
export { GET } from './[...path]/+server';
