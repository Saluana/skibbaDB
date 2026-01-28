import { Command, Flags, Args } from '@oclif/core';
import { Config } from '../../utils/config.js';
import { formatSuccess, formatInfo } from '../../utils/format.js';

export default class DbCreate extends Command {
  static description = 'Create or register a new database connection';

  static examples = [
    '<%= config.bin %> <%= command.id %> mydb --path ./mydb.db',
    '<%= config.bin %> <%= command.id %> memdb --memory',
    '<%= config.bin %> <%= command.id %> remote --path libsql://db.turso.io --auth-token token123',
  ];

  static flags = {
    path: Flags.string({
      char: 'p',
      description: 'Path to database file',
    }),
    memory: Flags.boolean({
      char: 'm',
      description: 'Create an in-memory database',
    }),
    driver: Flags.string({
      char: 'd',
      description: 'Database driver to use',
      options: ['bun', 'node'],
    }),
    libsql: Flags.boolean({
      description: 'Use LibSQL driver',
    }),
    'auth-token': Flags.string({
      description: 'Authentication token for remote database',
    }),
    'sync-url': Flags.string({
      description: 'Sync URL for embedded replica',
    }),
    'set-current': Flags.boolean({
      char: 's',
      description: 'Set as current database',
      default: true,
    }),
  };

  static args = {
    name: Args.string({
      required: true,
      description: 'Name for this database connection',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbCreate);

    // Validate flags
    if (!flags.path && !flags.memory) {
      this.error('Either --path or --memory must be specified');
    }

    if (flags.path && flags.memory) {
      this.error('Cannot specify both --path and --memory');
    }

    // Build config
    const dbConfig: any = {};

    if (flags.memory) {
      dbConfig.memory = true;
    } else if (flags.path) {
      dbConfig.path = flags.path;
    }

    if (flags.driver) {
      dbConfig.driver = flags.driver;
    }

    if (flags.libsql) {
      dbConfig.libsql = true;
    }

    if (flags['auth-token']) {
      dbConfig.authToken = flags['auth-token'];
    }

    if (flags['sync-url']) {
      dbConfig.syncUrl = flags['sync-url'];
    }

    // Save config
    const config = new Config();
    config.setDatabase(args.name, dbConfig);

    if (flags['set-current']) {
      config.setCurrentDatabase(args.name);
    }

    this.log(formatSuccess(`Database connection "${args.name}" created`));
    
    if (flags['set-current']) {
      this.log(formatInfo(`Set as current database`));
    }

    // Show config
    this.log('\nConfiguration:');
    this.log(JSON.stringify(dbConfig, null, 2));
  }
}
