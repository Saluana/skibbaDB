import { z } from 'zod/v3';

function formatZodIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length ? issue.path.join('.') : '(root)';
            return `${path}: ${issue.message}`;
        })
        .join('; ');
}

export class ValidationError extends Error {
    constructor(message: string, public details?: unknown) {
        const enhanced = ValidationError.enhanceMessage(message, details);
        super(enhanced);
        this.name = 'ValidationError';
        this.details = details;
    }

    private static enhanceMessage(message: string, details?: unknown): string {
        if (details instanceof z.ZodError) {
            const formatted = formatZodIssues(details);
            return (
                `${message}\n` +
                `Details: ${formatted}\n` +
                `Fix: correct the document fields before calling insert(), update(), or upsert().`
            );
        }
        if (message === 'Document validation failed' && details) {
            return ValidationError.enhanceMessage(
                'Document validation failed',
                details
            );
        }
        return message;
    }
}

export class UniqueConstraintError extends Error {
    constructor(message: string, public field?: string) {
        const enhanced =
            field && !message.includes(field)
                ? `${message}\nFix: use a unique value for "${field}".`
                : message.includes('Fix:')
                  ? message
                  : `${message}\nFix: ensure the value is unique for the constrained field.`;
        super(enhanced);
        this.name = 'UniqueConstraintError';
    }
}

export class CheckConstraintError extends Error {
    constructor(message: string, public details?: unknown) {
        super(message);
        this.name = 'CheckConstraintError';
    }
}

export class NotFoundError extends Error {
    constructor(message: string, public id?: string) {
        const enhanced = id
            ? `Document not found (id: ${id}).\nFix: verify the id or use upsert() to create the document.`
            : message;
        super(enhanced);
        this.name = 'NotFoundError';
    }
}

export class DatabaseError extends Error {
    constructor(message: string, public code?: string) {
        super(message);
        this.name = 'DatabaseError';
    }
}

export class PluginError extends Error {
    constructor(
        message: string,
        public pluginName: string,
        public hookName: string,
        public originalError?: Error
    ) {
        super(message);
        this.name = 'PluginError';
    }
}

export class PluginTimeoutError extends PluginError {
    constructor(
        pluginName: string,
        hookName: string,
        public timeout: number
    ) {
        super(
            `Plugin '${pluginName}' hook '${hookName}' timed out after ${timeout}ms`,
            pluginName,
            hookName
        );
        this.name = 'PluginTimeoutError';
    }
}

export class VersionMismatchError extends Error {
    constructor(
        message: string,
        public id: string,
        public expectedVersion: number,
        public actualVersion: number
    ) {
        super(
            `${message}\nFix: re-fetch the document and retry the update with the current _version.`
        );
        this.name = 'VersionMismatchError';
    }
}

export class CollectionExistsError extends DatabaseError {
    constructor(collectionName: string) {
        super(
            `Collection "${collectionName}" is already registered on this database instance.\n` +
                `Fix: call db.collection("${collectionName}") without a schema to retrieve it, or use a different collection name.`,
            'COLLECTION_ALREADY_EXISTS'
        );
        this.name = 'CollectionExistsError';
    }
}

export class CollectionNotFoundError extends DatabaseError {
    constructor(collectionName: string) {
        super(
            `Collection "${collectionName}" is not registered.\n` +
                `Fix: call db.collection("${collectionName}", schema) first to create it.`,
            'COLLECTION_NOT_FOUND'
        );
        this.name = 'CollectionNotFoundError';
    }
}
