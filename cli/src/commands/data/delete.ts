import { Command, Flags, Args } from '@oclif/core';
import { DBConnection } from '../../utils/db-connection.js';
import { formatSuccess } from '../../utils/format.js';
import { z } from 'zod';

export default class DataDelete extends Command {
  static description = 'Delete a document from a collection';

  static examples = [
    '<%= config.bin %> <%= command.id %> users doc-id',
  ];

  static flags = {
    confirm: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation prompt',
    }),
  };

  static args = {
    collection: Args.string({
      required: true,
      description: 'Collection name',
    }),
    id: Args.string({
      required: true,
      description: 'Document ID',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DataDelete);

    if (!flags.confirm) {
      this.log(`About to delete document "${args.id}" from collection "${args.collection}"`);
      this.log('Use --confirm/-y to skip this check');
      this.error('Cancelled - use --confirm/-y to proceed');
    }

    try {
      const db = DBConnection.getConnection();
      
      // Create a generic collection with z.any() schema
      const schema = z.any() as any;
      const collection = db.collection(args.collection, schema);

      const result = await collection.delete(args.id);

      if (result) {
        this.log(formatSuccess('Document deleted'));
      } else {
        this.error('Document not found');
      }
    } catch (error: any) {
      this.error(`Failed to delete document: ${error.message}`);
    }
  }
}
