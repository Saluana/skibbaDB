import { Command, Flags, Args } from '@oclif/core';
import { DBConnection } from '../../utils/db-connection.js';
import { formatTable, formatJSON } from '../../utils/format.js';

export default class DbQuery extends Command {
  static description = 'Execute a raw SQL query';

  static examples = [
    '<%= config.bin %> <%= command.id %> "SELECT * FROM users LIMIT 5"',
    '<%= config.bin %> <%= command.id %> "SELECT COUNT(*) FROM posts" --json',
  ];

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Output as JSON',
    }),
  };

  static args = {
    sql: Args.string({
      required: true,
      description: 'SQL query to execute',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbQuery);

    try {
      const db = DBConnection.getConnection();
      const results = db.querySync(args.sql);

      if (!results || results.length === 0) {
        this.log('No results');
        return;
      }

      if (flags.json) {
        this.log(formatJSON(results));
      } else {
        this.log(formatTable(results));
      }
    } catch (error: any) {
      this.error(`Failed to execute query: ${error.message}`);
    }
  }
}
