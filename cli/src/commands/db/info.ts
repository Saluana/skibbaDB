import { Command, Flags } from '@oclif/core';
import { Config } from '../../utils/config.js';
import { DBConnection } from '../../utils/db-connection.js';
import { formatSuccess, formatInfo, formatJSON } from '../../utils/format.js';

export default class DbInfo extends Command {
  static description = 'Show information about the current database';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    name: Flags.string({
      char: 'n',
      description: 'Database name (defaults to current)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DbInfo);

    const config = new Config();
    let dbName: string;
    let dbConfig: any;

    if (flags.name) {
      dbName = flags.name;
      dbConfig = config.getDatabase(flags.name);
      if (!dbConfig) {
        this.error(`Database "${flags.name}" not found`);
      }
    } else {
      const current = config.getCurrentDatabase();
      if (!current) {
        this.error('No current database set. Use "skibba db:use" to set one.');
      }
      dbName = current.name;
      dbConfig = current.config;
    }

    this.log(formatInfo(`Database: ${dbName}`));
    this.log('\nConfiguration:');
    this.log(formatJSON(dbConfig));

    // Try to get collections
    try {
      const db = DBConnection.getConnection(dbConfig);
      const collections = db
        .querySync("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .map((row: any) => row.name);

      this.log('\nCollections:');
      if (collections.length === 0) {
        this.log('  No collections');
      } else {
        collections.forEach((name: string) => {
          this.log(`  - ${name}`);
        });
      }
    } catch (error: any) {
      this.log('\nCould not retrieve collections: ' + error.message);
    } finally {
      DBConnection.close();
    }
  }
}
