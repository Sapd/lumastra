// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Column Registry for Token Tables
 *
 * Defines column configurations for PAT and Service token tables.
 * Eliminates type-based branching by providing declarative column definitions.
 *
 * @module components/admin/tokens/column-registry
 */

import type { Component } from 'svelte';
import * as m from '$lib/paraglide/messages.js';
import UserCell from './UserCell.svelte';
import NameCell from './NameCell.svelte';
import TokenCell from './TokenCell.svelte';
import ScopesCell from './ScopesCell.svelte';
import ActAsCell from './ActAsCell.svelte';
import CreatedByCell from './CreatedByCell.svelte';
import LastUsedCell from './LastUsedCell.svelte';
import ExpiresCell from './ExpiresCell.svelte';
import ActionsCell from './ActionsCell.svelte';

/**
 * Column definition for token tables.
 */
export interface ColumnDefinition {
    /** Column identifier */
    id: string;
    /** Column header text — a message function, resolved at render time for the active locale. */
    header: () => string;
    /** Cell renderer component */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cell: Component<any>;
    /** Column width class (optional) */
    widthClass?: string;
    /** Text alignment */
    align?: 'left' | 'right' | 'center';
}

/**
 * Column configurations for each token type.
 */
export const columnRegistry = {
    pat: [
        { id: 'user', header: m.route_admin_api_tokens_col_user, cell: UserCell, align: 'left' },
        { id: 'name', header: m.route_admin_api_tokens_col_name, cell: NameCell, align: 'left' },
        { id: 'token', header: m.route_admin_api_tokens_col_token, cell: TokenCell, align: 'left' },
        {
            id: 'scopes',
            header: m.route_admin_api_tokens_col_scopes,
            cell: ScopesCell,
            align: 'left',
        },
        {
            id: 'lastUsed',
            header: m.route_admin_api_tokens_col_last_used,
            cell: LastUsedCell,
            align: 'left',
        },
        {
            id: 'expires',
            header: m.route_admin_api_tokens_col_expires,
            cell: ExpiresCell,
            align: 'left',
        },
        {
            id: 'actions',
            header: m.route_admin_api_tokens_col_actions,
            cell: ActionsCell,
            align: 'right',
        },
    ],
    service: [
        { id: 'name', header: m.route_admin_api_tokens_col_name, cell: NameCell, align: 'left' },
        { id: 'token', header: m.route_admin_api_tokens_col_token, cell: TokenCell, align: 'left' },
        // A service token's scope is its ceiling (read/write/admin); the list
        // never showed it, so an admin could not tell a read-only token from
        // an admin one (admin/users review 2026-10-07, item 8a).
        {
            id: 'scopes',
            header: m.route_admin_api_tokens_col_scopes,
            cell: ScopesCell,
            align: 'left',
        },
        {
            id: 'actAs',
            header: m.route_admin_api_tokens_col_act_as,
            cell: ActAsCell,
            align: 'left',
        },
        {
            id: 'createdBy',
            header: m.route_admin_api_tokens_col_created_by,
            cell: CreatedByCell,
            align: 'left',
        },
        {
            id: 'lastUsed',
            header: m.route_admin_api_tokens_col_last_used,
            cell: LastUsedCell,
            align: 'left',
        },
        {
            id: 'expires',
            header: m.route_admin_api_tokens_col_expires,
            cell: ExpiresCell,
            align: 'left',
        },
        {
            id: 'actions',
            header: m.route_admin_api_tokens_col_actions,
            cell: ActionsCell,
            align: 'right',
        },
    ],
} satisfies Record<string, ColumnDefinition[]>;

/**
 * Get column definitions for a token type.
 */
export function getColumns(type: 'pat' | 'service'): ColumnDefinition[] {
    return columnRegistry[type];
}

/**
 * Empty state configuration for each token type.
 */
export const emptyStateConfig = {
    pat: {
        message: m.route_admin_api_tokens_empty_pat,
    },
    service: {
        message: m.route_admin_api_tokens_empty_service,
    },
} as const;

/**
 * Get empty state configuration for a token type.
 */
export function getEmptyState(type: 'pat' | 'service') {
    return emptyStateConfig[type];
}
