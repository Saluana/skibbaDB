import { Command, Args } from '@oclif/core';
import { DBConnection } from '../../utils/db-connection.js';
import { formatSuccess } from '../../utils/format.js';
import { z } from 'zod';

export default class DataUpdate extends Command {
  static description = 'Update a document in a collection';

  static examples = [
    '<%= config.bin %> <%= command.id %> users doc-id \'{"name": "Jane Doe"}\'',
  ];

  static args = {
    collection: Args.string({
      required: true,
      description: 'Collection name',
    }),
    id: Args.string({
      required: true,
      description: 'Document ID',
    }),
    data: Args.string({
      required: true,
      description: 'JSON data to update',
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(DataUpdate);

    let data: any;
    try {
      data = JSON.parse(args.data);
    } catch (error) {
      this.error('Invalid JSON data');
    }

    try {
      const db = DBConnection.getConnection();
      
      // Create a generic collection with z.any() schema
      const schema = z.any() as any;
      const collection = db.collection(args.collection, schema);

      const result = await collection.put(args.id, data);

      if (result) {
        this.log(formatSuccess('Document updated'));
      } else {
        this.error('Document not found');
      }
    } catch (error: any) {
      this.error(`Failed to update document: ${error.message}`);
    }
  }
}
