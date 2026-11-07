/** Instance identity of a Source: one kind may own many instances, each with its own settings key. */

/** Instance id is the settings key and every persisted record's `source`. */
export const instanceId = (kind: string, slug?: string): string => (slug ? `${kind}-${slug}` : kind)

/** The kind an instance id belongs to: the stored `kind`, else the id itself (schema 11 compatible). */
export const kindOf = (stored: { kind?: string } | undefined, id: string): string => stored?.kind ?? id

/** Whether a stored instance needs an explicit `kind` in settings (omit when it equals the id). */
export const storesKind = (instance: { id: string; kind: string }): boolean => instance.id !== instance.kind