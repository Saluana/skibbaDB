import { Database } from 'bun:sqlite';

let cachedVectorSupport: boolean | undefined;

export function isVectorExtensionAvailable(): boolean {
    if (cachedVectorSupport !== undefined) {
        return cachedVectorSupport;
    }

    try {
        const db = new Database(':memory:');
        db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[3])');
        cachedVectorSupport = true;
    } catch {
        cachedVectorSupport = false;
    }

    return cachedVectorSupport;
}
