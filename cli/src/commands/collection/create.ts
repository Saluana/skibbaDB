import { Command, Flags, Args } from '@oclif/core';
import { DBConnection } from '../../utils/db-connection.js';
import { formatSuccess, formatInfo } from '../../utils/format.js';
import { z } from 'zod';

export default class CollectionCreate extends Command {
  static description = 'Create a new collection with a schema';

  static examples = [
    '<%= config.bin %> <%= command.id %> users --schema \'{"id": "string", "name": "string", "email": "string"}\'',
    '<%= config.bin %> <%= command.id %> posts --schema \'{"id": "string", "title": "string", "content": "string", "authorId": "string"}\' --constrained email:unique,authorId:fk:users',
  ];

  static flags = {
    schema: Flags.string({
      char: 's',
      description: 'JSON schema definition',
      required: true,
    }),
    constrained: Flags.string({
      char: 'c',
      description: 'Constrained fields (format: field:constraint,field2:constraint2)',
    }),
  };

  static args = {
    name: Args.string({
      required: true,
      description: 'Collection name',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CollectionCreate);

    let schemaObj: any;
    try {
      schemaObj = JSON.parse(flags.schema);
    } catch (error) {
      this.error('Invalid JSON schema');
    }
    
    // Validate schema is an object
    if (typeof schemaObj !== 'object' || schemaObj === null || Array.isArray(schemaObj)) {
      this.error('Schema must be a JSON object');
    }
    
    // Validate schema has at least one field
    if (Object.keys(schemaObj).length === 0) {
      this.error('Schema must define at least one field');
    }

    // Build Zod schema from JSON definition
    const zodSchema = this.buildZodSchema(schemaObj);

    // Parse constrained fields
    const constrainedFields: any = {};
    if (flags.constrained) {
      const constraints = flags.constrained.split(',');
      for (const constraint of constraints) {
        const parts = constraint.split(':');
        const field = parts[0];
        const constraintType = parts[1];

        if (!constrainedFields[field]) {
          constrainedFields[field] = {};
        }

        if (constraintType === 'unique') {
          constrainedFields[field].unique = true;
        } else if (constraintType === 'fk' && parts[2]) {
          constrainedFields[field].foreignKey = `${parts[2]}._id`;
        } else if (constraintType === 'nullable') {
          constrainedFields[field].nullable = true;
        }
      }
    }

    try {
      const db = DBConnection.getConnection();
      const options = Object.keys(constrainedFields).length > 0 
        ? { constrainedFields } 
        : undefined;
      
      const collection = db.collection(args.name, zodSchema as any, options);
      
      // Wait a moment for async migrations to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      this.log(formatSuccess(`Collection "${args.name}" created`));
      
      if (Object.keys(constrainedFields).length > 0) {
        this.log(formatInfo('Constrained fields:'));
        this.log(JSON.stringify(constrainedFields, null, 2));
      }
    } catch (error: any) {
      this.error(`Failed to create collection: ${error.message}`);
    }
  }

  private buildZodSchema(schemaObj: any): z.ZodObject<any> {
    const shape: any = {};

    for (const [key, type] of Object.entries(schemaObj)) {
      switch (type) {
        case 'string':
          shape[key] = z.string();
          break;
        case 'number':
          shape[key] = z.number();
          break;
        case 'boolean':
          shape[key] = z.boolean();
          break;
        case 'date':
          shape[key] = z.date();
          break;
        case 'uuid':
          shape[key] = z.string().uuid();
          break;
        case 'email':
          shape[key] = z.string().email();
          break;
        case 'optional-string':
          shape[key] = z.string().optional();
          break;
        case 'optional-number':
          shape[key] = z.number().optional();
          break;
        default:
          // Try to parse as JSON for complex types
          if (typeof type === 'object') {
            shape[key] = this.buildZodSchema(type);
          } else {
            shape[key] = z.any();
          }
      }
    }

    return z.object(shape);
  }
}
