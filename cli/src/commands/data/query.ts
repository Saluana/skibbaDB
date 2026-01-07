import { Command, Flags, Args } from '@oclif/core';
import { DBConnection } from '../../utils/db-connection.js';
import { formatTable, formatJSON } from '../../utils/format.js';
import { z } from 'zod';

export default class DataQuery extends Command {
  static description = 'Query documents from a collection';

  static examples = [
    '<%= config.bin %> <%= command.id %> users',
    '<%= config.bin %> <%= command.id %> users --where \'{"name": "John"}\'',
    '<%= config.bin %> <%= command.id %> posts --limit 10 --order-by title',
    '<%= config.bin %> <%= command.id %> users --json',
  ];

  static flags = {
    where: Flags.string({
      char: 'w',
      description: 'Filter condition (JSON)',
    }),
    limit: Flags.integer({
      char: 'l',
      description: 'Limit number of results',
    }),
    offset: Flags.integer({
      char: 'o',
      description: 'Offset for pagination',
    }),
    'order-by': Flags.string({
      description: 'Field to order by',
    }),
    json: Flags.boolean({
      char: 'j',
      description: 'Output as JSON',
    }),
  };

  static args = {
    collection: Args.string({
      required: true,
      description: 'Collection name',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DataQuery);

    try {
      const db = DBConnection.getConnection();
      
      // Create a generic collection with z.any() schema
      const schema = z.any() as any;
      
      const collection = db.collection(args.collection, schema);

      // Build query
      let query: any = collection;

      // Apply where conditions
      if (flags.where) {
        let whereObj: any;
        try {
          whereObj = JSON.parse(flags.where);
        } catch (error) {
          this.error('Invalid JSON for --where');
        }

        for (const [field, value] of Object.entries(whereObj)) {
          query = query.where(field).eq(value);
        }
      }

      // Apply ordering
      if (flags['order-by']) {
        query = query.orderBy(flags['order-by']);
      }

      // Apply limit
      if (flags.limit) {
        query = query.limit(flags.limit);
      }

      // Apply offset
      if (flags.offset) {
        query = query.offset(flags.offset);
      }

      // Execute query
      const results = await query.toArray();

      if (results.length === 0) {
        this.log('No results found');
        return;
      }

      if (flags.json) {
        this.log(formatJSON(results));
      } else {
        this.log(`Found ${results.length} document(s):\n`);
        this.log(formatTable(results));
      }
    } catch (error: any) {
      this.error(`Failed to query collection: ${error.message}`);
    } finally {
      DBConnection.close();
    }
  }
}
