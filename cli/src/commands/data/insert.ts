import { Command, Flags, Args } from '@oclif/core';
import { DBConnection } from '../../utils/db-connection.js';
import { formatSuccess, formatJSON } from '../../utils/format.js';
import { z } from 'zod';

export default class DataInsert extends Command {
  static description = 'Insert a document into a collection';

  static examples = [
    '<%= config.bin %> <%= command.id %> users \'{"name": "John Doe", "email": "john@example.com"}\'',
    '<%= config.bin %> <%= command.id %> posts \'{"title": "Hello World", "content": "My first post"}\' --id custom-id',
  ];

  static flags = {
    id: Flags.string({
      char: 'i',
      description: 'Custom ID for the document',
    }),
  };

  static args = {
    collection: Args.string({
      required: true,
      description: 'Collection name',
    }),
    data: Args.string({
      required: true,
      description: 'JSON data to insert',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DataInsert);

    let data: any;
    try {
      data = JSON.parse(args.data);
    } catch (error) {
      this.error('Invalid JSON data');
    }

    // If custom ID provided, check if it already exists and warn
    if (flags.id) {
      if (data.id && data.id !== flags.id) {
        this.log(`Warning: Overwriting existing id "${data.id}" with "${flags.id}"`);
      }
      data.id = flags.id;
    }

    try {
      const db = DBConnection.getConnection();
      
      // Create a generic collection with z.any() schema
      const schema = z.any() as any;
      
      const collection = db.collection(args.collection, schema);
      const result = await collection.insert(data);

      this.log(formatSuccess('Document inserted'));
      this.log(formatJSON(result));
    } catch (error: any) {
      this.error(`Failed to insert document: ${error.message}`);
    }
  }
}
