import { Command, Flags } from '@oclif/core';
import { DBConnection } from '../../utils/db-connection.js';
import { formatTable } from '../../utils/format.js';

export default class CollectionList extends Command {
  static description = 'List all collections in the current database';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed information',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CollectionList);

    try {
      const db = DBConnection.getConnection();
      const tables = db.querySync(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );

      if (tables.length === 0) {
        this.log('No collections found');
        return;
      }

      if (flags.verbose) {
        tables.forEach((table: any) => {
          this.log(`\n${table.name}:`);
          this.log(table.sql);
          
          // Get row count
          const count = db.querySync(`SELECT COUNT(*) as count FROM ${table.name}`)[0];
          this.log(`Rows: ${count.count}`);
        });
      } else {
        const tableData = tables.map((table: any) => {
          const count = db.querySync(`SELECT COUNT(*) as count FROM ${table.name}`)[0];
          return {
            Name: table.name,
            'Row Count': count.count,
          };
        });

        this.log(formatTable(tableData));
      }
    } catch (error: any) {
      this.error(`Failed to list collections: ${error.message}`);
    } finally {
      DBConnection.close();
    }
  }
}
