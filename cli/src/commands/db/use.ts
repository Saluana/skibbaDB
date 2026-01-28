import { Command, Args } from '@oclif/core';
import { Config } from '../../utils/config.js';
import { formatSuccess } from '../../utils/format.js';

export default class DbUse extends Command {
  static description = 'Set the current database connection';

  static examples = ['<%= config.bin %> <%= command.id %> mydb'];

  static args = {
    name: Args.string({
      required: true,
      description: 'Name of the database connection to use',
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(DbUse);

    const config = new Config();
    const dbConfig = config.getDatabase(args.name);

    if (!dbConfig) {
      this.error(`Database "${args.name}" not found`);
    }

    config.setCurrentDatabase(args.name);
    this.log(formatSuccess(`Now using database "${args.name}"`));
  }
}
