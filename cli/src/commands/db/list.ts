import { Command } from '@oclif/core';
import { Config } from '../../utils/config.js';
import { formatSuccess, formatTable } from '../../utils/format.js';

export default class DbList extends Command {
  static description = 'List all configured database connections';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    await this.parse(DbList);
    
    const config = new Config();
    const databases = config.listDatabases();
    const current = config.getCurrentDatabase();

    if (databases.length === 0) {
      this.log('No databases configured');
      this.log('Use "skibba db:create" to create a database connection');
      return;
    }

    const tableData = databases.map((db) => ({
      Name: db.name,
      Current: db.name === current?.name ? '✓' : '',
      Type: db.config.memory ? 'Memory' : 'File',
      Path: db.config.path || '-',
      Driver: db.config.driver || 'auto',
    }));

    this.log(formatTable(tableData));
  }
}
