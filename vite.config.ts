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
            external: [
                'zod',
                'better-sqlite3',
                '@libsql/client',
                '@types/better-sqlite3',
                'sqlite-vec',
                'module',
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
                'bun:sqlite',
            ],
            output: {
                preserveModules: true,
                preserveModulesRoot: '.',
                entryFileNames: '[name].js',
            },
        },
        sourcemap: true,
        target: 'node18',
        outDir: 'dist',
        minify: 'terser',
        terserOptions: {
            compress: {
                passes: 3,
                drop_console: false,
                drop_debugger: true,
                ecma: 2020,
                module: true,
            },
            mangle: {
                toplevel: true,
            },
            format: {
                comments: false,
            },
        },
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
