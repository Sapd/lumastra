// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Navigation configuration components
export { default as NavigationSettings } from './NavigationSettings.svelte';
export { default as SidebarEditor } from './SidebarEditor.svelte';
export { default as FooterEditor } from './FooterEditor.svelte';
export { default as UserMenuEditor } from './UserMenuEditor.svelte';
export { default as HeroButtonsEditor } from './HeroButtonsEditor.svelte';
export { default as NavigationItemEditor } from './NavigationItemEditor.svelte';

// Re-export types - inline definitions since tsc can't resolve Svelte module script exports
export interface NavigationItem {
    id?: string;
    label: string;
    url?: string;
    icon?: string;
    external?: boolean;
    groups?: string[];
    section?: string;
    variant?: string;
    outline?: boolean;
}

export interface SidebarSection {
    id: string;
    label: string;
    icon?: string;
    collapsed?: boolean;
    displayOrder?: number;
    groups?: string[];
}

export interface SidebarLink extends NavigationItem {
    section?: string;
    outline?: boolean;
    displayOrder?: number;
}

export interface FooterLink extends NavigationItem {
    id: string;
    variant?: string;
}

export interface UserMenuLink extends NavigationItem {
    external?: boolean;
}

export interface HeroButton extends NavigationItem {
    id: string;
    action: 'search' | 'browse' | 'assistant' | 'link';
    label: string;
    icon: string;
    url?: string;
    external?: boolean;
    enabled: boolean;
}
