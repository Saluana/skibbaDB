import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createDB } from '../src';
import { ValidationError } from '../src/errors';

describe('Nested Field Validation (Issue 3.1)', () => {
    let db: any;

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    it('should validate valid nested field paths', () => {
        const schema = z.object({
            _id: z.string(),
            name: z.string(),
            metadata: z.object({
                category: z.string(),
                tags: z.array(z.string()),
            }),
        });

        const collection = db.collection('items', schema);
        
        // These should not throw - valid nested paths
        expect(() => collection.where('metadata.category')).not.toThrow();
        expect(() => collection.orderBy('metadata.category')).not.toThrow();
    });

    it('should reject invalid nested field paths with typos', () => {
        const schema = z.object({
            _id: z.string(),
            name: z.string(),
            metadata: z.object({
                category: z.string(),
                tags: z.array(z.string()),
            }),
        });

        const collection = db.collection('items', schema);
        
        // Typo: "metdata" instead of "metadata"
        expect(() => collection.where('metdata.category')).toThrow(ValidationError);
        expect(() => collection.where('metdata.category')).toThrow(/Invalid nested path/);
        
        // Typo: "categry" instead of "category"
        expect(() => collection.where('metadata.categry')).toThrow(ValidationError);
        expect(() => collection.where('metadata.categry')).toThrow(/Invalid nested path/);
    });

    it('should reject nested paths where parent is not an object', () => {
        const schema = z.object({
            _id: z.string(),
            name: z.string(),
            count: z.number(),
        });

        const collection = db.collection('items', schema);
        
        // "count" is a number, not an object, so "count.value" is invalid
        expect(() => collection.where('count.value')).toThrow(ValidationError);
    });

    it('should validate deeply nested paths', () => {
        const schema = z.object({
            _id: z.string(),
            data: z.object({
                nested: z.object({
                    deep: z.object({
                        value: z.string(),
                    }),
                }),
            }),
        });

        const collection = db.collection('items', schema);
        
        // Valid deep path
        expect(() => collection.where('data.nested.deep.value')).not.toThrow();
        
        // Invalid deep path (typo in middle)
        expect(() => collection.where('data.nsted.deep.value')).toThrow(ValidationError);
        expect(() => collection.where('data.nsted.deep.value')).toThrow(/segment 'nsted'/);
    });

    it('should handle optional nested objects', () => {
        const schema = z.object({
            _id: z.string(),
            name: z.string(),
            metadata: z.object({
                category: z.string(),
            }).optional(),
        });

        const collection = db.collection('items', schema);
        
        // Should validate even though metadata is optional
        expect(() => collection.where('metadata.category')).not.toThrow();
        
        // Should still reject invalid paths
        expect(() => collection.where('metadata.invalid')).toThrow(ValidationError);
    });

    it('should provide helpful error messages pointing to exact invalid segment', () => {
        const schema = z.object({
            _id: z.string(),
            user: z.object({
                profile: z.object({
                    name: z.string(),
                }),
            }),
        });

        const collection = db.collection('items', schema);
        
        try {
            collection.where('user.profle.name'); // typo: "profle" instead of "profile"
            expect.fail('Should have thrown ValidationError');
        } catch (error) {
            expect(error).toBeInstanceOf(ValidationError);
            expect((error as Error).message).toContain("segment 'profle'");
            expect((error as Error).message).toContain('user.profle');
        }
    });
});
