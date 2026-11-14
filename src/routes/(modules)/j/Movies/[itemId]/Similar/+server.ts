// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Movies/{itemId}/Similar — an alias Jellyfin's LibraryController.GetSimilarItems
// answers exactly like /Items/{itemId}/Similar.
export { GET } from '../../../Items/[itemId]/Similar/+server';
