import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            name: 'skibbaDB',
            fileName: (format) => `index.${format === 'es' ? 'js' : format}`,
            formats: ['es'],
        },
        rollupOptions: {
            external: (id) => {
                if (
                    id === 'bun:sqlite' ||
                    id.includes('drivers/bun') ||
                    id.endsWith('/drivers/bun.js')
                ) {
                    return true;
                }
                const externalDeps = [
                    'zod',
                    'zod/v3',
                    'better-sqlite3',
                    '@libsql/client',
                    '@types/better-sqlite3',
                    'sqlite-vec',
                    'module',
                    'node:module',
                    'node:async_hooks',
                    'node:path',
                    'node:url',
                    'node:process',
                    'node:fs',
                    'node:os',
                    'path',
                    'fs',
                    'url',
                    'os',
                    'process',
                ];
                return externalDeps.includes(id);
            },
            output: {
                preserveModules: true,
                preserveModulesRoot: 'src',
                entryFileNames: '[name].js',
            },
        },
        sourcemap: true,
        target: 'node18',
        outDir: 'dist',
        minify: 'esbuild',
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
    define: {
        global: 'globalThis',
    },
});
