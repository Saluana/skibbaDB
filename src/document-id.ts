/**
 * Maps public document IDs (default `id`) to internal SQLite `_id`.
 */
export function resolveInternalId(
    doc: Record<string, unknown>,
    publicIdField: string
): string | undefined {
    if (doc._id != null && doc._id !== '') {
        return String(doc._id);
    }
    if (publicIdField !== '_id') {
        const publicId = doc[publicIdField];
        if (publicId != null && publicId !== '') {
            return String(publicId);
        }
    }
    return undefined;
}

export function attachPublicId<T extends Record<string, unknown>>(
    doc: T,
    publicIdField: string
): T {
    const internalId = doc._id;
    if (internalId == null) {
        return doc;
    }
    if (publicIdField === '_id') {
        return doc;
    }
    return { ...doc, [publicIdField]: internalId } as T;
}

export function normalizeIncomingDoc(
    doc: Record<string, unknown>,
    publicIdField: string
): Record<string, unknown> {
    const internal = resolveInternalId(doc, publicIdField);
    if (!internal) {
        return { ...doc };
    }
    const next: Record<string, unknown> = { ...doc, _id: internal };
    if (publicIdField !== '_id') {
        delete next[publicIdField];
    }
    return next;
}
