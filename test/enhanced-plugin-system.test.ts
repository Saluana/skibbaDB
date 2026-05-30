import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import { z } from 'zod/v3';
import { createDB } from '../src/index';
import type { Database } from '../src/database';

// Import our hello world plugin examples will be done dynamically in tests

const userSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
});

describe('Enhanced Plugin System', () => {
    let db: Database;
    let consoleLogs: string[] = [];
    let originalConsoleLog: typeof console.log;
    let helloWorldPlugin: any;

    beforeEach(async () => {
        // Import the plugin module dynamically
        helloWorldPlugin = await import('../hello-world-plugin.js');
        
        db = createDB({ memory: true });

        // Capture console.log output
        consoleLogs = [];
        originalConsoleLog = console.log;
        console.log = (message: string) => {
            consoleLogs.push(message);
        };
    });

    afterEach(async () => {
        await db.close();
        console.log = originalConsoleLog;
    });

    test('should work with plugin class', async () => {
        // Use plugin class directly
        db.use(helloWorldPlugin.HelloWorldPlugin, { message: 'Class Plugin!' });

        const users = db.collection('users', userSchema);
        await users.insert({
            name: 'John Doe',
            email: 'john@example.com',
        });

        expect(db.listPlugins()).toHaveLength(1);
        expect(db.listPlugins()[0].name).toBe('hello-world');
        expect(consoleLogs.some((log) => log.includes('Class Plugin!'))).toBe(
            true
        );
    });

    test('should work with plugin factory function', async () => {
        // Use plugin factory
        db.use(helloWorldPlugin.createHelloWorldPlugin, {
            message: 'Factory Plugin!',
        });

        const users = db.collection('users', userSchema);
        await users.insert({
            name: 'Jane Smith',
            email: 'jane@example.com',
        });

        expect(db.listPlugins()).toHaveLength(1);
        expect(db.listPlugins()[0].name).toBe('hello-world');
        expect(consoleLogs.some((log) => log.includes('Factory Plugin!'))).toBe(
            true
        );
    });

    test('should work with plugin instance', async () => {
        // Use plugin instance
        db.use(helloWorldPlugin.helloWorldInstance);

        const users = db.collection('users', userSchema);
        await users.insert({
            name: 'Bob Wilson',
            email: 'bob@example.com',
        });

        expect(db.listPlugins()).toHaveLength(1);
        expect(db.listPlugins()[0].name).toBe('hello-world-instance');
        expect(consoleLogs.some((log) => log.includes('Greetings!'))).toBe(
            true
        );
    });

    test('should work with default export', async () => {
        // Use default export (simulating ES module default export)
        db.use(helloWorldPlugin.default, { message: 'Default Export!' });

        const users = db.collection('users', userSchema);
        await users.insert({
            name: 'Alice Johnson',
            email: 'alice@example.com',
        });

        expect(db.listPlugins()).toHaveLength(1);
        expect(db.listPlugins()[0].name).toBe('hello-world');
        expect(consoleLogs.some((log) => log.includes('Default Export!'))).toBe(
            true
        );
    });

    test('should work with ES module-like structure', async () => {
        // Simulate ES module with default export
        const esModule = { default: helloWorldPlugin.HelloWorldPlugin };
        db.use(esModule, { message: 'ES Module!' });

        const users = db.collection('users', userSchema);
        await users.insert({
            name: 'Charlie Brown',
            email: 'charlie@example.com',
        });

        expect(db.listPlugins()).toHaveLength(1);
        expect(db.listPlugins()[0].name).toBe('hello-world');
        expect(consoleLogs.some((log) => log.includes('ES Module!'))).toBe(
            true
        );
    });

    test('should chain multiple plugins', async () => {
        db.use(helloWorldPlugin.HelloWorldPlugin, {
            name: 'plugin-1',
            message: 'Plugin 1',
        })
            .use(helloWorldPlugin.createHelloWorldPlugin, {
                name: 'plugin-2',
                message: 'Plugin 2',
            })
            .use(helloWorldPlugin.helloWorldInstance);

        expect(db.listPlugins()).toHaveLength(3);

        const users = db.collection('users', userSchema);
        await users.insert({
            name: 'Multiple Test',
            email: 'multiple@example.com',
        });

        // Should have logs from all three plugins
        expect(consoleLogs.some((log) => log.includes('Plugin 1'))).toBe(true);
        expect(consoleLogs.some((log) => log.includes('Plugin 2'))).toBe(true);
        expect(consoleLogs.some((log) => log.includes('Greetings!'))).toBe(
            true
        );
    });

    test('should handle plugin lifecycle hooks', async () => {
        db.use(helloWorldPlugin.HelloWorldPlugin, {
            message: 'Lifecycle Test',
        });

        const users = db.collection('users', userSchema);

        // Test insert
        const user = await users.insert({
            name: 'Lifecycle User',
            email: 'lifecycle@example.com',
        });

        // Test query (using toArray which should trigger query hooks)
        await users.all();

        // Test update
        await users.update(user._id, { name: 'Updated User' });

        // Test delete
        await users.delete(user._id);

        // Verify all hooks were called
        expect(
            consoleLogs.some((log) => log.includes('Document inserted'))
        ).toBe(true);
        expect(consoleLogs.some((log) => log.includes('Querying users'))).toBe(
            true
        );
        expect(
            consoleLogs.some((log) => log.includes('Document updated'))
        ).toBe(true);
        expect(
            consoleLogs.some((log) => log.includes('Document deleted'))
        ).toBe(true);
    });

    test('should throw error for invalid plugin', () => {
        expect(() => {
            db.use('invalid plugin');
        }).toThrow(
            'Invalid plugin: must be Plugin instance, class, or factory function'
        );

        expect(() => {
            db.use(null);
        }).toThrow(
            'Invalid plugin: must be Plugin instance, class, or factory function'
        );

        expect(() => {
            db.use(123);
        }).toThrow(
            'Invalid plugin: must be Plugin instance, class, or factory function'
        );
    });

    test('should work without options', async () => {
        // Test using plugin without options
        db.use(helloWorldPlugin.HelloWorldPlugin);

        const users = db.collection('users', userSchema);
        await users.insert({
            name: 'No Options',
            email: 'nooptions@example.com',
        });

        expect(db.listPlugins()).toHaveLength(1);
        expect(
            consoleLogs.some((log) => log.includes('Hello from plugin!'))
        ).toBe(true);
    });
});
