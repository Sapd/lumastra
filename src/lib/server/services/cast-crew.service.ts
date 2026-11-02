// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cast & Crew Extraction Service
 *
 * Unified service for extracting and normalizing cast/crew information
 * from different media sources (TMDB, Jellyfin, etc.)
 */

/** Jellyfin person item structure */
export interface JellyfinPerson {
    Name?: string;
    Type?: string;
    Role?: string;
    Id?: string;
    PrimaryImageTag?: string;
}

/** Provider cast member from API response */
interface ProviderCastMember {
    id: number;
    name: string;
    character?: string;
    profile_path?: string | null;
    order?: number;
    gender?: number;
    known_for_department?: string;
}

/** Provider crew member from API response */
interface ProviderCrewMember {
    id: number;
    name: string;
    job: string;
    department?: string;
    profile_path?: string | null;
    gender?: number;
}

/** Provider credits input structure */
export interface ProviderCreditsInput {
    credits?: {
        cast?: ProviderCastMember[];
        crew?: ProviderCrewMember[];
    };
    cast?: ProviderCastMember[];
    crew?: ProviderCrewMember[];
}

/** @deprecated Use {@link ProviderCreditsInput} */
export type TmdbCreditsInput = ProviderCreditsInput;

/** Jellyfin data input structure */
export interface JellyfinDataInput {
    People?: JellyfinPerson[];
}

export interface CastMember {
    id: number | string;
    name: string;
    character?: string;
    profile_path?: string | null;
    order?: number;
    gender?: number;
    known_for_department?: string;
}

export interface CrewMember {
    id: number | string;
    name: string;
    job: string;
    department?: string;
    profile_path?: string | null;
    gender?: number;
}

export interface CastCrewInfo {
    cast: CastMember[];
    crew: CrewMember[];
    directors: CrewMember[];
    writers: CrewMember[];
    producers: CrewMember[];
}

/**
 * Cast & Crew Extraction Pipeline
 * Consolidates extraction logic previously duplicated across multiple files
 */
export class CastCrewService {
    /**
     * Extract cast information from TMDB data
     */
    static extractTMDBCast(data: TmdbCreditsInput | null, limit = 15): CastMember[] {
        if (!data) return [];

        const credits = data.credits || data;
        const cast: ProviderCastMember[] = credits.cast || [];

        return cast
            .slice(0, limit)
            .map((person: ProviderCastMember) => ({
                id: person.id,
                name: person.name,
                character: person.character,
                profile_path: person.profile_path,
                order: person.order,
                gender: person.gender,
                known_for_department: person.known_for_department,
            }))
            .filter((member: CastMember) => member.name && member.name.trim().length > 0);
    }

    /**
     * Extract crew information from TMDB data
     */
    static extractTMDBCrew(
        data: TmdbCreditsInput | null,
        departments?: string[],
        jobs?: string[],
    ): CrewMember[] {
        if (!data) return [];

        const credits = data.credits || data;
        const crew: ProviderCrewMember[] = credits.crew || [];

        let filteredCrew = crew;

        // Filter by departments if specified
        if (departments && departments.length > 0) {
            filteredCrew = filteredCrew.filter(
                (person: ProviderCrewMember) =>
                    person.department && departments.includes(person.department),
            );
        }

        // Filter by specific jobs if specified
        if (jobs && jobs.length > 0) {
            filteredCrew = filteredCrew.filter((person: ProviderCrewMember) =>
                jobs.includes(person.job),
            );
        }

        return filteredCrew
            .map((person: ProviderCrewMember) => ({
                id: person.id,
                name: person.name,
                job: person.job,
                department: person.department,
                profile_path: person.profile_path,
                gender: person.gender,
            }))
            .filter((member: CrewMember) => member.name && member.name.trim().length > 0);
    }

    /**
     * Extract cast information from Jellyfin data
     */
    static extractJellyfinCast(data: JellyfinDataInput | null, limit = 15): CastMember[] {
        if (!data) return [];

        const people: JellyfinPerson[] = data.People || [];

        return people
            .filter((person: JellyfinPerson) => person.Type === 'Actor')
            .slice(0, limit)
            .map((person: JellyfinPerson, index: number) => ({
                id: person.Id || `jellyfin-${index}`,
                name: person.Name || '',
                character: person.Role,
                profile_path: null, // Jellyfin doesn't provide profile paths
                order: index,
            }))
            .filter((member: CastMember) => member.name && member.name.trim().length > 0);
    }

    /**
     * Extract crew information from Jellyfin data
     */
    static extractJellyfinCrew(data: JellyfinDataInput | null, jobs?: string[]): CrewMember[] {
        if (!data) return [];

        const people: JellyfinPerson[] = data.People || [];
        const validJobs = jobs || ['Director', 'Writer', 'Producer', 'Composer'];

        return people
            .filter((person: JellyfinPerson) => person.Type && validJobs.includes(person.Type))
            .map((person: JellyfinPerson, index: number) => ({
                id: person.Id || `jellyfin-crew-${index}`,
                name: person.Name || '',
                job: person.Type || 'Unknown',
                department: CastCrewService.getDepartmentForJob(person.Type || 'Unknown'),
                profile_path: null,
            }))
            .filter((member: CrewMember) => member.name && member.name.trim().length > 0);
    }

    /**
     * Get department for a given job
     */
    static getDepartmentForJob(job: string): string {
        const jobToDepartment: Record<string, string> = {
            Director: 'Directing',
            Writer: 'Writing',
            Producer: 'Production',
            'Executive Producer': 'Production',
            Composer: 'Sound',
            Cinematographer: 'Camera',
            Editor: 'Editing',
            'Costume Designer': 'Costume & Make-Up',
            'Production Designer': 'Art',
        };

        return jobToDepartment[job] || 'Unknown';
    }

    /**
     * Extract comprehensive cast and crew information
     */
    static extractCastAndCrew(
        data: TmdbCreditsInput | JellyfinDataInput | null,
        source: 'tmdb' | 'jellyfin' = 'tmdb',
        options: {
            maxCast?: number;
            includeDepartments?: string[];
            includeJobs?: string[];
        } = {},
    ): CastCrewInfo {
        const { maxCast = 15, includeDepartments, includeJobs } = options;

        let cast: CastMember[] = [];
        let crew: CrewMember[] = [];

        switch (source) {
            case 'tmdb':
                cast = CastCrewService.extractTMDBCast(data as TmdbCreditsInput | null, maxCast);
                crew = CastCrewService.extractTMDBCrew(
                    data as TmdbCreditsInput | null,
                    includeDepartments,
                    includeJobs,
                );
                break;

            case 'jellyfin':
                cast = CastCrewService.extractJellyfinCast(
                    data as JellyfinDataInput | null,
                    maxCast,
                );
                crew = CastCrewService.extractJellyfinCrew(
                    data as JellyfinDataInput | null,
                    includeJobs,
                );
                break;
        }

        // Extract specific roles
        const directors = crew.filter((member) => member.job === 'Director');
        const writers = crew.filter(
            (member) =>
                member.job === 'Writer' || member.job === 'Screenplay' || member.job === 'Story',
        );
        const producers = crew.filter(
            (member) => member.job === 'Producer' || member.job === 'Executive Producer',
        );

        return {
            cast,
            crew,
            directors,
            writers,
            producers,
        };
    }

    /**
     * Get top cast members (lead actors)
     */
    static getTopCast(cast: CastMember[], limit = 5): CastMember[] {
        return cast.sort((a, b) => (a.order || 999) - (b.order || 999)).slice(0, limit);
    }

    /**
     * Get key crew members (director, main writer, main producer)
     */
    static getKeyCrew(crew: CrewMember[]): {
        director?: CrewMember;
        writer?: CrewMember;
        producer?: CrewMember;
    } {
        const director = crew.find((member) => member.job === 'Director');
        const writer = crew.find(
            (member) => member.job === 'Writer' || member.job === 'Screenplay',
        );
        const producer = crew.find(
            (member) => member.job === 'Producer' || member.job === 'Executive Producer',
        );

        return {
            director,
            writer,
            producer,
        };
    }

    /**
     * Generate cast text for embedding/search
     */
    static generateCastText(cast: CastMember[], limit = 5): string {
        const topCast = CastCrewService.getTopCast(cast, limit);
        return topCast.map((member) => member.name).join(', ');
    }

    /**
     * Generate crew text for embedding/search
     */
    static generateCrewText(crew: CrewMember[]): string {
        const keyCrew = CastCrewService.getKeyCrew(crew);
        const parts: string[] = [];

        if (keyCrew.director) {
            parts.push(`Director: ${keyCrew.director.name}`);
        }
        if (keyCrew.writer) {
            parts.push(`Writer: ${keyCrew.writer.name}`);
        }
        if (keyCrew.producer) {
            parts.push(`Producer: ${keyCrew.producer.name}`);
        }

        return parts.join(', ');
    }

    /**
     * Calculate cast/crew similarity between two media items
     */
    static calculateCastSimilarity(cast1: CastMember[], cast2: CastMember[]): number {
        if (!cast1.length || !cast2.length) return 0;

        const ids1 = new Set(cast1.map((member) => member.id));
        const ids2 = new Set(cast2.map((member) => member.id));

        const intersection = new Set([...ids1].filter((id) => ids2.has(id)));
        const union = new Set([...ids1, ...ids2]);

        return union.size > 0 ? intersection.size / union.size : 0;
    }

    /**
     * Calculate crew similarity between two media items
     */
    static calculateCrewSimilarity(crew1: CrewMember[], crew2: CrewMember[]): number {
        if (!crew1.length || !crew2.length) return 0;

        const ids1 = new Set(crew1.map((member) => member.id));
        const ids2 = new Set(crew2.map((member) => member.id));

        const intersection = new Set([...ids1].filter((id) => ids2.has(id)));
        const union = new Set([...ids1, ...ids2]);

        return union.size > 0 ? intersection.size / union.size : 0;
    }

    /**
     * Merge cast information from multiple sources with deduplication
     */
    static mergeCast(primaryCast: CastMember[], secondaryCast: CastMember[]): CastMember[] {
        const merged = [...primaryCast];
        const existingNames = new Set(
            primaryCast.map((member) => member.name.toLowerCase().trim()),
        );

        // Add non-duplicate members from secondary source
        secondaryCast.forEach((member) => {
            const normalizedName = member.name.toLowerCase().trim();
            if (!existingNames.has(normalizedName)) {
                merged.push(member);
                existingNames.add(normalizedName);
            }
        });

        return merged;
    }

    /**
     * Merge crew information from multiple sources with deduplication
     */
    static mergeCrew(primaryCrew: CrewMember[], secondaryCrew: CrewMember[]): CrewMember[] {
        const merged = [...primaryCrew];
        const existingKeys = new Set(
            primaryCrew.map((member) => `${member.name.toLowerCase().trim()}-${member.job}`),
        );

        // Add non-duplicate members from secondary source
        secondaryCrew.forEach((member) => {
            const key = `${member.name.toLowerCase().trim()}-${member.job}`;
            if (!existingKeys.has(key)) {
                merged.push(member);
                existingKeys.add(key);
            }
        });

        return merged;
    }

    /**
     * Filter cast/crew by popularity or known works
     */
    static filterByPopularity(
        members: (CastMember | CrewMember)[],
        limit = 10,
    ): (CastMember | CrewMember)[] {
        // Sort by order (for cast) or keep as is (for crew)
        return members
            .sort((a, b) => {
                // Prioritize members with profile images (more popular)
                const aHasImage = a.profile_path ? 1 : 0;
                const bHasImage = b.profile_path ? 1 : 0;

                if (aHasImage !== bHasImage) {
                    return bHasImage - aHasImage;
                }

                // For cast, sort by order
                if ('order' in a && 'order' in b) {
                    return (a.order || 999) - (b.order || 999);
                }

                return 0;
            })
            .slice(0, limit);
    }

    /**
     * Validate cast/crew member data
     */
    static validateCastMember(member: unknown): member is CastMember {
        if (!member || typeof member !== 'object') return false;
        const obj = member as Record<string, unknown>;
        return typeof obj.name === 'string' && obj.name.trim().length > 0 && obj.id !== undefined;
    }

    static validateCrewMember(member: unknown): member is CrewMember {
        if (!member || typeof member !== 'object') return false;
        const obj = member as Record<string, unknown>;
        return (
            typeof obj.name === 'string' &&
            typeof obj.job === 'string' &&
            obj.name.trim().length > 0 &&
            obj.job.trim().length > 0 &&
            obj.id !== undefined
        );
    }

    /**
     * Clean and validate cast/crew arrays
     */
    static cleanCastArray(cast: unknown[]): CastMember[] {
        return cast.filter(CastCrewService.validateCastMember).filter(
            (member, index, self) =>
                // Remove duplicates by name (case-insensitive)
                index === self.findIndex((m) => m.name.toLowerCase() === member.name.toLowerCase()),
        );
    }

    static cleanCrewArray(crew: unknown[]): CrewMember[] {
        return crew.filter(CastCrewService.validateCrewMember).filter(
            (member, index, self) =>
                // Remove duplicates by name+job combination
                index ===
                self.findIndex(
                    (m) =>
                        m.name.toLowerCase() === member.name.toLowerCase() &&
                        m.job.toLowerCase() === member.job.toLowerCase(),
                ),
        );
    }
}

// Export singleton instance for convenience
export const castCrewService = CastCrewService;
