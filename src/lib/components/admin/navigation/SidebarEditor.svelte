<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    import { stopPropagation } from '$lib/utils/event-helpers';

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
        labels?: Partial<Record<string, string>>;
    }

    export interface SidebarSection {
        id: string;
        label: string;
        icon?: string;
        collapsed?: boolean;
        displayOrder?: number; // Position in navigation (interleaved with top-level links)
        groups?: string[]; // Required groups to see this section (empty = visible to all)
        labels?: Partial<Record<string, string>>; // Per-language names; `label` is the fallback
    }

    export interface SidebarLink extends NavigationItem {
        section?: string;
        outline?: boolean;
        displayOrder?: number; // Position in navigation (only for top-level links)
    }

    // Unified navigation item for interleaved ordering
    export type UnifiedNavItem =
        | {
              type: 'link';
              id: string;
              displayOrder: number;
              link: SidebarLink;
              originalIndex: number;
          }
        | {
              type: 'section';
              id: string;
              displayOrder: number;
              section: SidebarSection;
          };
</script>

<script lang="ts">
    import { dndzone, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import * as m from '$lib/paraglide/messages';
    import {
        Icon,
        Plus,
        FolderPlus,
        Trash,
        PencilSquare,
        ChevronDown,
        ChevronRight,
        ChevronUp,
        Bars3,
        InformationCircle,
        // Section icons
        Folder,
        Cog8Tooth,
        RectangleGroup,
        CommandLine,
        Tv,
        Film,
        MusicalNote,
        BookOpen,
    } from 'svelte-hero-icons';
    import NavigationItemEditor from './NavigationItemEditor.svelte';
    import AddGroupInline from './AddGroupInline.svelte';
    import LocalizedLabelFields from './LocalizedLabelFields.svelte';
    import { cleanLabels } from '$lib/shared/localized-label';

    const flipDurationMs = 200;

    interface Props {
        links?: SidebarLink[];
        sections?: SidebarSection[];
        availableGroups?: string[];
        availableLocalIcons?: string[];
        onchange?: (detail: { links: SidebarLink[]; sections: SidebarSection[] }) => void;
        onaddgroup?: (groups: string[]) => void;
    }

    let {
        links = $bindable([]),
        sections = $bindable([]),
        availableGroups = ['admin', 'users'],
        availableLocalIcons = [],
        onchange,
        onaddgroup,
    }: Props = $props();

    // Section icon mapping
    const sectionIconMap: Record<string, typeof Folder> = {
        folder: Folder,
        'cog-8-tooth': Cog8Tooth,
        'rectangle-group': RectangleGroup,
        'command-line': CommandLine,
        tv: Tv,
        film: Film,
        'musical-note': MusicalNote,
        'book-open': BookOpen,
    };

    // Track which link is being edited (for auto-edit on create)
    let editingLinkIndex = $state<number | null>(null);
    // Stable id of the link that was just created (null when no unsaved new link
    // exists). Using an id instead of a boolean prevents the stale-flag bug where
    // opening a different item's editor before saving/cancelling the new one would
    // cause the wrong (fully-labelled) link to be deleted on cancel.
    let editingNewLinkId = $state<string | null>(null);

    // Resolve the CURRENT index of a link inside the full links[] array.
    // The editors capture `originalIndex` from a derived map; if links[] mutates
    // while an item stays in edit mode (DnD finalize elsewhere, addLink/deleteLink
    // shifting earlier items), that captured index goes stale. We re-resolve here:
    // prefer the stable id, then object identity, and only fall back to the
    // captured index when neither resolves.
    function resolveLinkIndex(link: SidebarLink, fallbackIndex: number): number {
        if (typeof link.id === 'string' && link.id.length > 0) {
            const byId = links.findIndex((l) => l.id === link.id);
            if (byId >= 0) return byId;
        }
        const byRef = links.indexOf(link);
        if (byRef >= 0) return byRef;
        return fallbackIndex;
    }

    // Section editing state
    let editingSection = $state<string | null>(null);
    let newSectionLabel = $state('');
    let newSectionIcon = $state('');

    // Collapsed sections in the editor (for preview)
    // eslint-disable-next-line svelte/no-unnecessary-state-wrap -- needed for reactivity
    let collapsedSections = $state(new SvelteSet<string>());

    function emitChange() {
        onchange?.({ links, sections });
    }

    function getSection(item: UnifiedNavItem): SidebarSection {
        if (item.type !== 'section') {
            throw new Error('Expected section item');
        }
        return item.section;
    }

    // Get the maximum displayOrder across all top-level links and sections
    function getMaxDisplayOrder(): number {
        const topLevelOrders = links.filter((l) => !l.section).map((l) => l.displayOrder ?? -1);
        const sectionOrders = sections.map((s) => s.displayOrder ?? -1);
        return Math.max(-1, ...topLevelOrders, ...sectionOrders);
    }

    // Load default sidebar configuration
    function loadDefaults() {
        // Each default carries a stable id (like addLink) so DnD/edit keys stay
        // identity-based instead of falling back to a positional key — otherwise
        // reordering freshly-loaded defaults before any per-item edit could
        // mis-track flip animations.
        links = [
            {
                id: crypto.randomUUID(),
                label: 'Home',
                url: '/',
                icon: 'home',
                external: false,
                outline: true,
                displayOrder: 0,
            },
            {
                id: crypto.randomUUID(),
                label: 'Browse',
                url: '/browse',
                icon: 'magnifying-glass',
                external: false,
                outline: true,
                displayOrder: 1,
            },
            {
                id: crypto.randomUUID(),
                label: 'Music',
                url: '/music',
                icon: 'musical-note',
                external: false,
                displayOrder: 2,
            },
            {
                id: crypto.randomUUID(),
                label: 'Audiobooks',
                url: '/library/audiobook',
                icon: 'book-open',
                external: false,
                displayOrder: 3,
            },
            {
                id: crypto.randomUUID(),
                label: 'Playlists',
                url: '/playlists',
                icon: 'queue-list',
                external: false,
                displayOrder: 4,
            },
            {
                id: crypto.randomUUID(),
                label: 'Admin',
                url: '/admin',
                icon: 'cog-6-tooth',
                external: false,
                groups: ['__ADMIN__'],
                displayOrder: 5,
            },
        ];
        sections = [];
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    // Link operations
    function addLink(toSection?: string) {
        const newId = crypto.randomUUID();
        const newLink: SidebarLink = {
            id: newId,
            label: 'New Link',
            url: '/',
            icon: 'home',
            external: false,
            section: toSection,
            // For top-level links, set displayOrder at the end; section links don't need displayOrder
            displayOrder: toSection ? undefined : getMaxDisplayOrder() + 1,
        };

        // Always append to the end of links[]. The section grouping is derived
        // by `link.section`, so a new section link still renders at the end of
        // its section's block via sectionLinksMap. Appending keeps every
        // existing item's index stable (no splice-before-first-match shifting),
        // so editingLinkIndex === links.length - 1 reliably points at the new
        // link's originalIndex for startInEditMode.
        links = [...links, newLink];
        editingLinkIndex = links.length - 1;
        editingNewLinkId = newId;
        emitChange();
    }

    function updateLink(target: SidebarLink, capturedIndex: number, updatedLink: NavigationItem) {
        const index = resolveLinkIndex(target, capturedIndex);
        const oldLink = links[index];
        const newLink = updatedLink as SidebarLink;

        // Handle transition between section and top-level
        const wasInSection = !!oldLink?.section;
        const isNowInSection = !!newLink.section;

        if (wasInSection && !isNowInSection) {
            // Moving from section to top-level: assign displayOrder at end
            newLink.displayOrder = getMaxDisplayOrder() + 1;
        } else if (!wasInSection && isNowInSection) {
            // Moving from top-level to section: clear displayOrder
            newLink.displayOrder = undefined;
        }
        // If staying in same type, preserve existing displayOrder

        links = links.map((link, i) => (i === index ? newLink : link));
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    function deleteLink(target: SidebarLink, capturedIndex: number) {
        const index = resolveLinkIndex(target, capturedIndex);
        links = links.filter((_, i) => i !== index);
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    function handleCancel(target: SidebarLink, capturedIndex: number) {
        const index = resolveLinkIndex(target, capturedIndex);
        const link = links[index];
        // Only auto-delete if this specific link is the unsaved new one.
        // Checking by id (not a shared boolean) prevents the stale-flag bug where
        // cancelling an existing item's editor would incorrectly delete it.
        if (link && ((editingNewLinkId !== null && link.id === editingNewLinkId) || !link.label)) {
            links = links.filter((_, i) => i !== index);
            emitChange();
        }
        editingLinkIndex = null;
        editingNewLinkId = null;
    }

    // DnD handlers for unified navigation items (top-level links + sections interleaved)
    function handleUnifiedDndConsider(e: CustomEvent<{ items: UnifiedNavItem[] }>) {
        unifiedNavItems = e.detail.items;
    }

    function handleUnifiedDndFinalize(e: CustomEvent<{ items: UnifiedNavItem[] }>) {
        const newItems = e.detail.items.filter(
            (item) =>
                item.id !== SHADOW_PLACEHOLDER_ITEM_ID &&
                ((item.type === 'link' && !!item.link) ||
                    (item.type === 'section' && !!item.section)),
        );

        // Update displayOrder on all items based on new position
        newItems.forEach((item, index) => {
            item.displayOrder = index;
        });

        // Reconstruct links and sections from unified items
        const newTopLevelLinks: SidebarLink[] = [];
        const newSections: SidebarSection[] = [];

        for (const item of newItems) {
            if (item.type === 'link') {
                newTopLevelLinks.push({
                    ...item.link,
                    displayOrder: item.displayOrder,
                });
            } else {
                newSections.push({
                    ...item.section,
                    displayOrder: item.displayOrder,
                });
            }
        }

        // Preserve section links (links with a section property)
        const sectionLinks = links.filter((l) => l.section);

        // Update the arrays
        links = [...newTopLevelLinks, ...sectionLinks];
        sections = newSections;

        emitChange();
    }

    // DnD handlers for links within a section
    function handleSectionLinksDndConsider(
        sectionId: string,
        e: CustomEvent<{
            items: Array<{
                link: SidebarLink;
                originalIndex: number;
                id: string;
            }>;
        }>,
    ) {
        // Override the derived map for this section during the drag so the live
        // preview reorders (mirrors handleUnifiedDndConsider for the top-level
        // zone). On finalize the links array changes and the $derived recomputes,
        // discarding this transient override.
        sectionLinksMap = { ...sectionLinksMap, [sectionId]: e.detail.items };
    }

    function handleSectionLinksDndFinalize(
        sectionId: string,
        e: CustomEvent<{
            items: Array<{
                link: SidebarLink;
                originalIndex: number;
                id: string;
            }>;
        }>,
    ) {
        const newSectionLinks = e.detail.items.filter(
            (item) => item.id !== SHADOW_PLACEHOLDER_ITEM_ID && !!item.link,
        );
        // Reconstruct links array: top-level + other sections + this section's new order
        const topLevel = links.filter((l) => !l.section);
        const otherSections = links.filter((l) => l.section && l.section !== sectionId);
        links = [...topLevel, ...otherSections, ...newSectionLinks.map((item) => item.link)];
        emitChange();
    }

    // Keyboard reorder for unified top-level items (links + sections)
    function moveUnifiedItem(position: number, direction: -1 | 1): void {
        const ordered = [...unifiedNavItems];
        const target = position + direction;
        if (position < 0 || position >= ordered.length || target < 0 || target >= ordered.length) {
            return;
        }
        // Swap positions
        const [moved] = ordered.splice(position, 1);
        ordered.splice(target, 0, moved);

        // Reassign sequential displayOrder and reconstruct arrays
        const newTopLevelLinks: SidebarLink[] = [];
        const newSections: SidebarSection[] = [];
        ordered.forEach((item, index) => {
            if (item.type === 'link') {
                newTopLevelLinks.push({ ...item.link, displayOrder: index });
            } else {
                newSections.push({ ...item.section, displayOrder: index });
            }
        });

        const sectionLinks = links.filter((l) => l.section);
        links = [...newTopLevelLinks, ...sectionLinks];
        sections = newSections;
        emitChange();
    }

    // Keyboard reorder for links within a section
    function moveSectionLink(sectionId: string, position: number, direction: -1 | 1): void {
        const current = sectionLinksMap[sectionId] ?? [];
        const target = position + direction;
        if (position < 0 || position >= current.length || target < 0 || target >= current.length) {
            return;
        }
        const reordered = [...current];
        const [moved] = reordered.splice(position, 1);
        reordered.splice(target, 0, moved);

        const topLevel = links.filter((l) => !l.section);
        const otherSections = links.filter((l) => l.section && l.section !== sectionId);
        links = [...topLevel, ...otherSections, ...reordered.map((item) => item.link)];
        emitChange();
    }

    // Section operations
    function addSection() {
        if (!newSectionLabel.trim()) return;
        const newId = newSectionLabel
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '');
        // A label made entirely of non-ASCII / symbol characters (emoji, CJK,
        // Cyrillic, "???", etc.) strips down to an empty id. An empty id collides
        // with the SectionDropdown's "no section" ('') option and can never hold a
        // saved link (sanitizeForSave drops '' to undefined), so reject it.
        if (newId.length === 0) {
            alert('Section name must contain at least one letter or number (a-z, 0-9).');
            return;
        }
        // Check for duplicate ID
        if (sections.some((s) => s.id === newId)) {
            alert(m.admin_navigation_sidebar_duplicate_section_alert());
            return;
        }
        const newDisplayOrder = getMaxDisplayOrder() + 1;
        sections = [
            ...sections,
            {
                id: newId,
                label: newSectionLabel.trim(),
                icon: newSectionIcon || undefined,
                collapsed: true,
                displayOrder: newDisplayOrder,
            },
        ];
        newSectionLabel = '';
        newSectionIcon = '';
        emitChange();
    }

    function updateSection(id: string, updates: Partial<SidebarSection>, close = true) {
        sections = sections.map((s) => (s.id === id ? { ...s, ...updates } : s));
        if (close) editingSection = null;
        emitChange();
    }

    /**
     * Section name + translations are edited on a draft and applied with Save.
     * The name used to be committed on blur, which also closed the editor — so
     * clicking into anything else in it (a translation field) ended the edit
     * before you could type.
     */
    let sectionDraft = $state<{ label: string; labels: Partial<Record<string, string>> }>({
        label: '',
        labels: {},
    });

    function startSectionEdit(section: SidebarSection): void {
        if (editingSection === section.id) {
            editingSection = null;
            return;
        }
        sectionDraft = { label: section.label, labels: { ...(section.labels ?? {}) } };
        editingSection = section.id;
    }

    function saveSectionEdit(id: string): void {
        const label = sectionDraft.label.trim();
        if (!label) return;
        updateSection(id, { label, labels: cleanLabels(sectionDraft.labels) });
    }

    function onSectionNameKeydown(e: KeyboardEvent, id: string): void {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveSectionEdit(id);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            editingSection = null;
        }
    }

    function deleteSection(id: string) {
        const sectionName = sections.find((s) => s.id === id)?.label;
        if (
            !confirm(m.admin_navigation_sidebar_delete_section_confirm({ name: sectionName ?? '' }))
        )
            return;
        // Move links out of section
        links = links.map((link) => (link.section === id ? { ...link, section: undefined } : link));
        sections = sections.filter((s) => s.id !== id);
        emitChange();
    }

    function toggleSectionCollapse(id: string) {
        if (collapsedSections.has(id)) {
            collapsedSections.delete(id);
        } else {
            collapsedSections.add(id);
        }
        collapsedSections = new SvelteSet(collapsedSections);
    }

    // Toggle a group for a section
    function toggleSectionGroup(sectionId: string, group: string) {
        const section = sections.find((s) => s.id === sectionId);
        if (!section) return;

        const currentGroups = section.groups || [];
        let newGroups: string[];
        if (currentGroups.includes(group)) {
            newGroups = currentGroups.filter((g) => g !== group);
        } else {
            newGroups = [...currentGroups, group];
        }
        // Keep the editor open: a group toggle is one of several edits in it.
        updateSection(sectionId, { groups: newGroups }, false);
    }

    // Unified navigation items: top-level links + sections interleaved by displayOrder
    let unifiedNavItems = $derived.by((): UnifiedNavItem[] => {
        // Calculate current max for fallback (items without displayOrder go to end)
        const currentMax = Math.max(
            0,
            ...links.filter((l) => !l.section).map((l) => l.displayOrder ?? 0),
            ...sections.map((s) => s.displayOrder ?? 0),
        );

        const topLevelLinksItems: UnifiedNavItem[] = links
            .filter((link) => !link.section)
            .map((link, idx) => ({
                type: 'link' as const,
                id:
                    typeof link.id === 'string' && link.id.length > 0
                        ? link.id
                        : `link-${links.indexOf(link)}-${link.url ?? ''}-${link.label || idx}`,
                // Items without displayOrder go after all items with displayOrder
                displayOrder: link.displayOrder ?? currentMax + 1 + idx,
                link,
                originalIndex: links.indexOf(link),
            }));

        const sectionItems: UnifiedNavItem[] = sections.map((section, idx) => ({
            type: 'section' as const,
            id: `section-${section.id}`,
            // Items without displayOrder sort after all ordered items. The +1001
            // offset (vs links' +1+idx) keeps unordered sections after unordered
            // links AND matches Sidebar.svelte's navEntries fallback exactly, so
            // the editor preview and the live sidebar order mixed ordered/unordered
            // configs identically (and avoids any realistic fallback collision).
            displayOrder: section.displayOrder ?? currentMax + 1001 + idx,
            section,
        }));

        // Combine and sort by displayOrder
        return [...topLevelLinksItems, ...sectionItems].sort(
            (a, b) => a.displayOrder - b.displayOrder,
        );
    });

    // Keep section links map in sync with links/sections updates
    let sectionLinksMap = $derived.by(() => {
        const nextMap: Record<
            string,
            Array<{ link: SidebarLink; originalIndex: number; id: string }>
        > = {};

        for (const section of sections) {
            const sectionLinks: Array<{
                link: SidebarLink;
                originalIndex: number;
                id: string;
            }> = links
                .map((link, originalIndex) => {
                    const label = typeof link.label === 'string' ? link.label : 'new';
                    const id =
                        typeof link.id === 'string' && link.id.length > 0
                            ? link.id
                            : `section-${section.id}-link-${originalIndex}-${label}`;
                    return {
                        link,
                        originalIndex,
                        id,
                    };
                })
                .filter(({ link }) => link.section === section.id);

            nextMap[section.id] = sectionLinks;
        }

        return nextMap;
    });

    // Available icons for sections
    const sectionIcons = [
        'folder',
        'cog-8-tooth',
        'rectangle-group',
        'command-line',
        'tv',
        'film',
        'musical-note',
        'book-open',
    ];
</script>

<div class="space-y-4">
    <!-- Navigation Items Header -->
    <div class="between">
        <h4 class="text-sm font-medium text-surface-300">
            {m.admin_navigation_sidebar_items_header()}
        </h4>
        <div class="flex gap-2">
            <button
                type="button"
                class="px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 text-sm rounded-lg transition-colors flex items-center gap-1"
                onclick={() => addLink()}>
                <Icon src={Plus} class="w-4 h-4" />
                {m.admin_navigation_sidebar_add_link()}
            </button>
        </div>
    </div>

    <!-- Empty State -->
    {#if links.length === 0 && sections.length === 0}
        <div class="card-glass border border-surface-700">
            <div class="text-center py-6 text-surface-500">
                <p>{m.admin_navigation_sidebar_empty()}</p>
                <p class="text-xs mt-2 text-surface-400">
                    {m.admin_navigation_sidebar_empty_hint()}
                </p>
                <button type="button" class="btn btn-gray mt-4" onclick={loadDefaults}>
                    {m.admin_navigation_sidebar_load_defaults()}
                </button>
            </div>
        </div>
    {:else}
        <!-- Unified Navigation Items (Links + Sections interleaved) -->
        <div
            class="space-y-2"
            use:dndzone={{
                items: unifiedNavItems,
                flipDurationMs,
                type: 'nav-top',
                dropFromOthersDisabled: true,
                dropTargetStyle: {
                    outline: '2px dashed rgba(6, 182, 212, 0.5)',
                    borderRadius: '8px',
                },
            }}
            onconsider={handleUnifiedDndConsider}
            onfinalize={handleUnifiedDndFinalize}>
            {#each unifiedNavItems as item, position (item.id)}
                <div animate:flip={{ duration: flipDurationMs }}>
                    {#if item.type === 'link'}
                        <!-- Top-Level Link -->
                        <div
                            class="flex items-center gap-2 card-glass border border-surface-700 !p-2">
                            <!-- Drag Handle -->
                            <div
                                class="cursor-grab active:cursor-grabbing text-surface-500 hover:text-surface-300 shrink-0 p-1"
                                role="button"
                                tabindex="-1"
                                aria-label={m.admin_navigation_sidebar_drag_link()}>
                                <Icon src={Bars3} class="w-4 h-4" />
                            </div>
                            <div class="flex-1">
                                <NavigationItemEditor
                                    item={item.link}
                                    index={item.originalIndex}
                                    isFirst={position === 0}
                                    isLast={position === unifiedNavItems.length - 1}
                                    startInEditMode={editingLinkIndex === item.originalIndex}
                                    {sections}
                                    showSection={true}
                                    showOutline={true}
                                    showExternal={true}
                                    externalLabel="External service (embed in iframe)"
                                    showGroups={true}
                                    {availableGroups}
                                    {availableLocalIcons}
                                    {onaddgroup}
                                    onupdate={(detail) =>
                                        updateLink(item.link, item.originalIndex, detail)}
                                    ondelete={() => deleteLink(item.link, item.originalIndex)}
                                    oncancel={() => handleCancel(item.link, item.originalIndex)}
                                    onmoveUp={() => moveUnifiedItem(position, -1)}
                                    onmoveDown={() => moveUnifiedItem(position, 1)} />
                            </div>
                        </div>
                    {:else}
                        <!-- Section with its links -->
                        {@const section = getSection(item)}
                        {@const sectionLinks = sectionLinksMap[section.id] || []}
                        <div class="card-glass border border-surface-700 overflow-hidden !p-0">
                            <!-- Section Header -->
                            <div
                                class="flex items-center gap-2 p-3 bg-surface-700/30 border-b border-surface-700">
                                <!-- Drag Handle for Section -->
                                <div
                                    class="cursor-grab active:cursor-grabbing text-surface-500 hover:text-surface-300 shrink-0 p-1"
                                    role="button"
                                    tabindex="-1"
                                    aria-label={m.admin_navigation_sidebar_drag_section()}>
                                    <Icon src={Bars3} class="w-4 h-4" />
                                </div>

                                <!-- Keyboard reorder for section -->
                                <div class="flex flex-col gap-0.5 shrink-0">
                                    <button
                                        type="button"
                                        class="p-0.5 text-surface-500 hover:text-surface-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                        disabled={position === 0}
                                        onclick={() => moveUnifiedItem(position, -1)}
                                        aria-label={m.admin_navigation_sidebar_section_move_up()}
                                        title={m.admin_navigation_sidebar_section_move_up()}>
                                        <Icon src={ChevronUp} class="w-4 h-4" />
                                    </button>
                                    <button
                                        type="button"
                                        class="p-0.5 text-surface-500 hover:text-surface-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                        disabled={position === unifiedNavItems.length - 1}
                                        onclick={() => moveUnifiedItem(position, 1)}
                                        aria-label={m.admin_navigation_sidebar_section_move_down()}
                                        title={m.admin_navigation_sidebar_section_move_down()}>
                                        <Icon src={ChevronDown} class="w-4 h-4" />
                                    </button>
                                </div>

                                <button
                                    type="button"
                                    class="p-1 text-surface-400 hover:text-white transition-colors"
                                    aria-expanded={!collapsedSections.has(section.id)}
                                    aria-label={collapsedSections.has(section.id)
                                        ? m.admin_navigation_sidebar_section_expand()
                                        : m.admin_navigation_sidebar_section_collapse()}
                                    onclick={() => toggleSectionCollapse(section.id)}>
                                    <Icon
                                        src={collapsedSections.has(section.id)
                                            ? ChevronRight
                                            : ChevronDown}
                                        class="w-4 h-4" />
                                </button>

                                <!-- Section Icon -->
                                <div
                                    class="w-6 h-6 rounded bg-surface-700/50 center text-surface-400">
                                    {#if section.icon && sectionIconMap[section.icon]}
                                        <Icon src={sectionIconMap[section.icon]} class="w-4 h-4" />
                                    {:else}
                                        <Icon src={Folder} class="w-4 h-4" />
                                    {/if}
                                </div>

                                {#if editingSection === section.id}
                                    <div class="flex-1 space-y-2">
                                        <!-- Section Name -->
                                        <!-- svelte-ignore a11y_autofocus -->
                                        <input
                                            type="text"
                                            bind:value={sectionDraft.label}
                                            onkeydown={(e) => onSectionNameKeydown(e, section.id)}
                                            aria-label={m.admin_navigation_sidebar_edit_section_name()}
                                            class="w-full px-2 py-1 bg-surface-800 border border-surface-600 rounded text-sm text-surface-200"
                                            autofocus />
                                        <LocalizedLabelFields
                                            labels={sectionDraft.labels}
                                            fallback={sectionDraft.label}
                                            idPrefix="section-{section.id}-i18n"
                                            onchange={(labels) =>
                                                (sectionDraft = { ...sectionDraft, labels })} />
                                        <!-- Section Groups -->
                                        {#if availableGroups.length > 0}
                                            <div class="flex flex-wrap gap-1">
                                                <span class="text-[10px] text-surface-500 mr-1"
                                                    >{m.admin_navigation_sidebar_groups_label()}</span>
                                                {#each availableGroups as group (group)}
                                                    <button
                                                        type="button"
                                                        class="px-1.5 py-0.5 text-[10px] rounded-full transition-colors {(
                                                            section.groups || []
                                                        ).includes(group)
                                                            ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-500/50'
                                                            : 'bg-surface-700 text-surface-400 border border-surface-600 hover:border-surface-500'}"
                                                        onmousedown={(e) => e.preventDefault()}
                                                        onclick={stopPropagation(() =>
                                                            toggleSectionGroup(section.id, group),
                                                        )}>
                                                        {group}
                                                    </button>
                                                {/each}
                                                <button
                                                    type="button"
                                                    class="px-1.5 py-0.5 text-[10px] rounded-full transition-colors {(
                                                        section.groups || []
                                                    ).includes('__ADMIN__')
                                                        ? 'bg-yellow-500/30 text-yellow-300 border border-yellow-500/50'
                                                        : 'bg-surface-700 text-surface-400 border border-surface-600 hover:border-surface-500'}"
                                                    onmousedown={(e) => e.preventDefault()}
                                                    onclick={stopPropagation(() =>
                                                        toggleSectionGroup(section.id, '__ADMIN__'),
                                                    )}>
                                                    {m.admin_navigation_sidebar_admin_only()}
                                                </button>
                                            </div>
                                        {/if}
                                        {#if onaddgroup}
                                            <AddGroupInline
                                                {availableGroups}
                                                onadded={onaddgroup} />
                                        {/if}
                                        <div class="flex justify-end gap-2">
                                            <button
                                                type="button"
                                                class="btn btn-sm variant-ghost-surface"
                                                onclick={() => (editingSection = null)}
                                                >{m.admin_navigation_item_cancel()}</button>
                                            <button
                                                type="button"
                                                class="btn btn-sm variant-filled-primary"
                                                disabled={!sectionDraft.label.trim()}
                                                onclick={() => saveSectionEdit(section.id)}
                                                >{m.admin_navigation_item_save()}</button>
                                        </div>
                                    </div>
                                {:else}
                                    <div class="flex-1">
                                        <span class="text-sm font-medium text-surface-300"
                                            >{section.label}</span>
                                        {#if section.groups && section.groups.length > 0}
                                            <div class="flex gap-1 mt-0.5">
                                                {#each section.groups as group (group)}
                                                    <span
                                                        class="px-1 py-0.5 text-[9px] rounded bg-surface-600 text-surface-300">
                                                        {group === '__ADMIN__'
                                                            ? m.admin_navigation_sidebar_admin_only()
                                                            : group}
                                                    </span>
                                                {/each}
                                            </div>
                                        {/if}
                                    </div>
                                {/if}

                                <span class="text-caption bg-surface-800/50 px-2 py-0.5 rounded">
                                    {sectionLinks.length !== 1
                                        ? m.admin_navigation_sidebar_section_link_count_many({
                                              count: sectionLinks.length,
                                          })
                                        : m.admin_navigation_sidebar_section_link_count_one({
                                              count: sectionLinks.length,
                                          })}
                                </span>

                                <button
                                    type="button"
                                    class="p-1.5 text-surface-500 hover:text-cyan-400 transition-colors rounded hover:bg-surface-600/50"
                                    onclick={() => addLink(section.id)}
                                    aria-label={m.admin_navigation_sidebar_add_link_to_section()}
                                    title={m.admin_navigation_sidebar_add_link_to_section()}>
                                    <Icon src={Plus} class="w-4 h-4" />
                                </button>
                                <button
                                    type="button"
                                    class="p-1.5 text-surface-500 hover:text-cyan-400 transition-colors rounded hover:bg-surface-600/50"
                                    onclick={() => startSectionEdit(section)}
                                    aria-label={m.admin_navigation_sidebar_edit_section_name()}
                                    title={m.admin_navigation_sidebar_edit_section_name()}>
                                    <Icon src={PencilSquare} class="w-4 h-4" />
                                </button>
                                <button
                                    type="button"
                                    class="p-1.5 text-surface-500 hover:text-red-400 transition-colors rounded hover:bg-surface-600/50"
                                    onclick={() => deleteSection(section.id)}
                                    aria-label={m.admin_navigation_sidebar_delete_section()}
                                    title={m.admin_navigation_sidebar_delete_section()}>
                                    <Icon src={Trash} class="w-4 h-4" />
                                </button>
                            </div>

                            <!-- Section Links -->
                            {#if !collapsedSections.has(section.id)}
                                <div class="p-3">
                                    {#if sectionLinks.length === 0}
                                        <p class="text-caption text-center py-4">
                                            {m.admin_navigation_sidebar_section_no_links()}
                                            <button
                                                type="button"
                                                class="text-cyan-400 hover:underline"
                                                onclick={stopPropagation(() => addLink(section.id))}
                                                >{m.admin_navigation_sidebar_section_add_one()}</button>
                                        </p>
                                    {:else}
                                        <div
                                            class="space-y-2"
                                            use:dndzone={{
                                                items: sectionLinks,
                                                flipDurationMs,
                                                type: `section-${section.id}`,
                                                dropFromOthersDisabled: true,
                                                dropTargetStyle: {
                                                    outline: '2px dashed rgba(6, 182, 212, 0.3)',
                                                    borderRadius: '8px',
                                                },
                                            }}
                                            onconsider={(e) =>
                                                handleSectionLinksDndConsider(section.id, e)}
                                            onfinalize={(e) =>
                                                handleSectionLinksDndFinalize(section.id, e)}>
                                            {#each sectionLinks as linkItem, position (linkItem.id)}
                                                <div
                                                    animate:flip={{
                                                        duration: flipDurationMs,
                                                    }}
                                                    class="flex items-center gap-2">
                                                    <!-- Drag Handle -->
                                                    <div
                                                        class="cursor-grab active:cursor-grabbing text-surface-500 hover:text-surface-300 shrink-0 p-1"
                                                        role="button"
                                                        tabindex="-1"
                                                        aria-label={m.admin_navigation_sidebar_drag_link()}>
                                                        <Icon src={Bars3} class="w-4 h-4" />
                                                    </div>
                                                    <div class="flex-1">
                                                        <NavigationItemEditor
                                                            item={linkItem.link}
                                                            index={linkItem.originalIndex}
                                                            isFirst={position === 0}
                                                            isLast={position ===
                                                                sectionLinks.length - 1}
                                                            startInEditMode={editingLinkIndex ===
                                                                linkItem.originalIndex}
                                                            {sections}
                                                            showSection={true}
                                                            showOutline={true}
                                                            showExternal={true}
                                                            externalLabel="External service (embed in iframe)"
                                                            showGroups={true}
                                                            {availableGroups}
                                                            {availableLocalIcons}
                                                            {onaddgroup}
                                                            onupdate={(detail) =>
                                                                updateLink(
                                                                    linkItem.link,
                                                                    linkItem.originalIndex,
                                                                    detail,
                                                                )}
                                                            ondelete={() =>
                                                                deleteLink(
                                                                    linkItem.link,
                                                                    linkItem.originalIndex,
                                                                )}
                                                            oncancel={() =>
                                                                handleCancel(
                                                                    linkItem.link,
                                                                    linkItem.originalIndex,
                                                                )}
                                                            onmoveUp={() =>
                                                                moveSectionLink(
                                                                    section.id,
                                                                    position,
                                                                    -1,
                                                                )}
                                                            onmoveDown={() =>
                                                                moveSectionLink(
                                                                    section.id,
                                                                    position,
                                                                    1,
                                                                )} />
                                                    </div>
                                                </div>
                                            {/each}
                                        </div>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}

    <!-- Add New Section -->
    <div class="bg-surface-800/30 rounded-lg border border-dashed border-surface-600 p-4">
        <h4 class="text-sm font-medium text-surface-400 mb-3 flex items-center gap-2">
            <Icon src={FolderPlus} class="w-4 h-4" />
            {m.admin_navigation_sidebar_add_section_header()}
        </h4>
        <div class="flex gap-2 flex-wrap">
            <input
                type="text"
                bind:value={newSectionLabel}
                placeholder={m.admin_navigation_sidebar_section_name_placeholder()}
                aria-label={m.admin_navigation_sidebar_section_name_placeholder()}
                class="flex-1 min-w-[150px] px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-surface-200 placeholder-surface-500"
                onkeydown={(e) => e.key === 'Enter' && addSection()} />
            <div class="flex items-center gap-2">
                <!-- Icon preview -->
                <div
                    class="w-10 h-10 rounded bg-surface-700/50 center text-surface-400 border border-surface-600">
                    {#if newSectionIcon && sectionIconMap[newSectionIcon]}
                        <Icon src={sectionIconMap[newSectionIcon]} class="w-5 h-5" />
                    {:else}
                        <Icon src={Folder} class="w-5 h-5 opacity-50" />
                    {/if}
                </div>
                <select
                    bind:value={newSectionIcon}
                    aria-label={m.admin_navigation_sidebar_section_name_placeholder()}
                    class="px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-surface-200">
                    <option value="">{m.admin_navigation_sidebar_section_icon_default()}</option>
                    {#each sectionIcons as icon (icon)}
                        <option value={icon}>{icon}</option>
                    {/each}
                </select>
            </div>
            <button
                type="button"
                class="btn btn-gray flex items-center gap-2"
                onclick={addSection}
                disabled={!newSectionLabel.trim()}>
                <Icon src={Plus} class="w-4 h-4" />
                {m.admin_navigation_sidebar_add_section_btn()}
            </button>
        </div>
        <p class="text-caption mt-2">
            {m.admin_navigation_sidebar_add_section_hint()}
        </p>
    </div>

    <!-- Help Info -->
    <div class="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
        <div class="flex gap-2">
            <Icon src={InformationCircle} class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div class="text-xs text-blue-300 space-y-1">
                <p><strong>Tips:</strong></p>
                <ul class="list-disc list-inside space-y-0.5">
                    <li>
                        Use <code class="bg-surface-800 px-1 rounded">__ADMIN__</code> group to restrict
                        links to admins
                    </li>
                    <li>Enable "External" for links that should open in an iframe</li>
                    <li>
                        Move links between sections by editing and changing the section dropdown
                    </li>
                    <li>Leave groups empty to show links to all users</li>
                </ul>
            </div>
        </div>
    </div>
</div>
