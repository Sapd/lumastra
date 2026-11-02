// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Column Registry for Namespace Table
 *
 * Defines column configurations for the cache namespace performance table.
 * Follows the same declarative pattern as the token column registry.
 *
 * @module components/admin/namespaces/column-registry
 */

import type { Component } from 'svelte';
import NamespaceNameCell from './NamespaceNameCell.svelte';
import L1HitsCell from './L1HitsCell.svelte';
import L1MissesCell from './L1MissesCell.svelte';
import L2HitsCell from './L2HitsCell.svelte';
import HitRateCell from './HitRateCell.svelte';
import SizeCell from './SizeCell.svelte';
import NamespaceActionsCell from './NamespaceActionsCell.svelte';

/**
 * Column definition for namespace table.
 */
export interface NamespaceColumnDefinition {
    /** Column identifier */
    id: string;
    /** Column header text */
    header: string;
    /** Cell renderer component */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cell: Component<any>;
    /** Text alignment */
    align?: 'left' | 'right' | 'center';
}

/**
 * Column definitions for the namespace performance table.
 */
export const namespaceColumns: NamespaceColumnDefinition[] = [
    {
        id: 'namespace',
        header: 'Namespace',
        cell: NamespaceNameCell,
        align: 'left',
    },
    { id: 'l1Hits', header: 'L1 Hits', cell: L1HitsCell, align: 'right' },
    {
        id: 'l1Misses',
        header: 'L1 Misses',
        cell: L1MissesCell,
        align: 'right',
    },
    { id: 'l2Hits', header: 'L2 Hits', cell: L2HitsCell, align: 'right' },
    { id: 'hitRate', header: 'Hit Rate', cell: HitRateCell, align: 'right' },
    { id: 'size', header: 'Size', cell: SizeCell, align: 'right' },
    {
        id: 'actions',
        header: 'Actions',
        cell: NamespaceActionsCell,
        align: 'center',
    },
];

/**
 * Get column definitions for the namespace table.
 */
export function getNamespaceColumns(): NamespaceColumnDefinition[] {
    return namespaceColumns;
}
