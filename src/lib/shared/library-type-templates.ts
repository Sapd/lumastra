// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export interface MetadataFieldDef {
    key: string;
    label: string;
    type: 'text' | 'date' | 'number' | 'boolean' | 'tags' | 'select';
    options?: string[];
    autocompleteFrom?: string;
    required?: boolean;
    showOnCard?: boolean;
    showInDetail?: boolean;
}

export interface FolderParseRule {
    depth: number;
    metadataKey: string;
    extractYear?: boolean;
}

export interface CardDisplayConfig {
    showRating: boolean;
    showGenre: boolean;
    subtitleTemplate: string;
    fallbackPoster: 'popcorn' | 'frame_extract' | 'type_icon';
    progressMeaning: 'watch_progress' | 'completion';
    /** Label for individual items within a series (e.g. 'Clips', 'Lessons', 'Videos'). */
    clipLabel: string;
}

export interface BrowseConfig {
    /** Selects the browse UI variant: timeline=year ribbon, department_tree=accordion, course=episode list, grid=flat grid. */
    layout: 'timeline' | 'department_tree' | 'course' | 'grid';
    groupBy: string[];
    defaultSort: 'chronological' | 'alphabetical' | 'department' | 'added';
    filters: string[];
}

export interface LibraryTypeTemplate {
    type: string;
    label: string;
    icon: string;
    providerMatching: boolean;
    hierarchyMode: 'flat' | 'series';
    metadataFields: MetadataFieldDef[];
    folderParsingRules: FolderParseRule[];
    cardConfig: CardDisplayConfig;
    browseConfig: BrowseConfig;
}

export const LIBRARY_TYPE_TEMPLATES: Record<string, LibraryTypeTemplate> = {
    home_video: {
        type: 'home_video',
        label: 'Home Videos',
        icon: 'video-camera',
        providerMatching: false,
        // Flat, not 'series': home videos are a flat collection (each clip = one item).
        // 'series' mode made the scanner treat every folder as a 1-episode TV "series"
        // (…-s01e01 slugs + spurious season/episode rows). Only true course-style types
        // (training/educational — a folder of lessons) use hierarchyMode 'series'.
        hierarchyMode: 'flat',
        metadataFields: [
            {
                key: 'date_filmed',
                label: 'Date Filmed',
                type: 'date',
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'location',
                label: 'Location',
                type: 'text',
                autocompleteFrom: 'location',
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'people',
                label: 'People',
                type: 'tags',
                autocompleteFrom: 'people',
                showInDetail: true,
            },
            {
                key: 'event',
                label: 'Event',
                type: 'text',
                autocompleteFrom: 'event',
                showOnCard: true,
                showInDetail: true,
            },
            { key: 'notes', label: 'Notes', type: 'text', showInDetail: true },
        ],
        folderParsingRules: [
            { depth: 1, metadataKey: 'date_filmed', extractYear: true },
            { depth: 2, metadataKey: 'event' },
        ],
        cardConfig: {
            showRating: false,
            showGenre: false,
            subtitleTemplate: '{date_filmed} - {location}',
            fallbackPoster: 'frame_extract',
            progressMeaning: 'watch_progress',
            clipLabel: 'Videos',
        },
        browseConfig: {
            layout: 'timeline',
            groupBy: ['date_filmed', 'event'],
            defaultSort: 'chronological',
            filters: ['event', 'location'],
        },
    },
    training: {
        type: 'training',
        label: 'Training',
        icon: 'academic-cap',
        providerMatching: false,
        hierarchyMode: 'series',
        metadataFields: [
            {
                key: 'instructor',
                label: 'Instructor',
                type: 'text',
                autocompleteFrom: 'instructor',
                showInDetail: true,
            },
            {
                key: 'department',
                label: 'Department',
                type: 'text',
                autocompleteFrom: 'department',
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'category',
                label: 'Category',
                type: 'text',
                autocompleteFrom: 'category',
                showInDetail: true,
            },
            {
                key: 'difficulty',
                label: 'Difficulty',
                type: 'select',
                options: ['beginner', 'intermediate', 'advanced'],
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'required',
                label: 'Required',
                type: 'boolean',
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'due_date',
                label: 'Due Date',
                type: 'date',
                showOnCard: true,
                showInDetail: true,
            },
        ],
        folderParsingRules: [
            { depth: 1, metadataKey: 'department' },
            { depth: 2, metadataKey: 'category' },
        ],
        cardConfig: {
            showRating: false,
            showGenre: false,
            subtitleTemplate: '{department} - {difficulty}',
            fallbackPoster: 'frame_extract',
            progressMeaning: 'completion',
            clipLabel: 'Clips',
        },
        browseConfig: {
            layout: 'department_tree',
            groupBy: ['department', 'category'],
            defaultSort: 'department',
            filters: ['department', 'difficulty', 'required'],
        },
    },
    educational: {
        type: 'educational',
        label: 'Educational',
        icon: 'book-open',
        providerMatching: false,
        hierarchyMode: 'series',
        metadataFields: [
            {
                key: 'instructor',
                label: 'Instructor',
                type: 'text',
                autocompleteFrom: 'instructor',
                showInDetail: true,
            },
            {
                key: 'subject',
                label: 'Subject',
                type: 'text',
                autocompleteFrom: 'subject',
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'grade_level',
                label: 'Grade Level',
                type: 'text',
                autocompleteFrom: 'grade_level',
                showInDetail: true,
            },
            {
                key: 'course',
                label: 'Course',
                type: 'text',
                autocompleteFrom: 'course',
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'lesson_number',
                label: 'Lesson Number',
                type: 'number',
                showOnCard: true,
                showInDetail: true,
            },
        ],
        folderParsingRules: [
            { depth: 1, metadataKey: 'subject' },
            { depth: 2, metadataKey: 'course' },
        ],
        cardConfig: {
            showRating: false,
            showGenre: false,
            subtitleTemplate: '{instructor} - {subject}',
            fallbackPoster: 'frame_extract',
            progressMeaning: 'completion',
            clipLabel: 'Lessons',
        },
        browseConfig: {
            layout: 'course',
            groupBy: ['subject', 'course'],
            defaultSort: 'alphabetical',
            filters: ['subject', 'instructor', 'grade_level'],
        },
    },
    personal: {
        type: 'personal',
        label: 'Personal',
        icon: 'folder',
        providerMatching: false,
        hierarchyMode: 'flat',
        metadataFields: [
            {
                key: 'tags',
                label: 'Tags',
                type: 'tags',
                autocompleteFrom: 'tags',
                showOnCard: true,
                showInDetail: true,
            },
            { key: 'notes', label: 'Notes', type: 'text', showInDetail: true },
        ],
        folderParsingRules: [],
        cardConfig: {
            showRating: false,
            showGenre: false,
            subtitleTemplate: '{tags}',
            fallbackPoster: 'frame_extract',
            progressMeaning: 'watch_progress',
            clipLabel: 'Videos',
        },
        browseConfig: {
            layout: 'grid',
            groupBy: ['tags'],
            defaultSort: 'added',
            filters: ['tags'],
        },
    },
    product: {
        type: 'product',
        label: 'Product Videos',
        icon: 'cube',
        providerMatching: false,
        hierarchyMode: 'flat',
        metadataFields: [
            {
                key: 'product_name',
                label: 'Product Name',
                type: 'text',
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'category',
                label: 'Category',
                type: 'text',
                autocompleteFrom: 'category',
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'sku',
                label: 'SKU',
                type: 'text',
                showInDetail: true,
            },
            {
                key: 'version',
                label: 'Version',
                type: 'text',
                showOnCard: true,
                showInDetail: true,
            },
            {
                key: 'summary',
                label: 'Summary',
                type: 'text',
                showInDetail: true,
            },
            {
                key: 'tags',
                label: 'Tags',
                type: 'tags',
                autocompleteFrom: 'tags',
                showOnCard: true,
                showInDetail: true,
            },
        ],
        folderParsingRules: [
            { depth: 1, metadataKey: 'category' },
            { depth: 2, metadataKey: 'product_name' },
        ],
        cardConfig: {
            showRating: false,
            showGenre: false,
            subtitleTemplate: '{product_name} - {category}',
            fallbackPoster: 'frame_extract',
            progressMeaning: 'watch_progress',
            clipLabel: 'Videos',
        },
        browseConfig: {
            layout: 'grid',
            groupBy: ['category', 'product_name'],
            defaultSort: 'alphabetical',
            filters: ['category', 'tags'],
        },
    },
};

/** Get template for a library type, returns undefined for entertainment types. */
export function getLibraryTypeTemplate(mediaType: string): LibraryTypeTemplate | undefined {
    return LIBRARY_TYPE_TEMPLATES[mediaType];
}

/** Render a subtitle template by replacing {key} placeholders with metadata values. */
export function renderSubtitleTemplate(
    template: string,
    metadata: Record<string, unknown>,
): string {
    return template
        .replace(/\{(\w+)\}/g, (_match, key: string) => {
            const value = metadata[key];
            if (value == null || value === '') return '';
            if (Array.isArray(value)) return value.join(', ');
            return String(value);
        })
        .replace(/\s*-\s*$/, '')
        .replace(/^\s*-\s*/, '')
        .trim();
}
