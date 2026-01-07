import { createDB, Database } from 'skibbadb';
import { Config, DBConfig } from './config.js';

export class DBConnection {
  private static instance: Database | null = null;
  private static currentConfig: DBConfig | null = null;

  private static configEquals(a: DBConfig, b: DBConfig): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  static getConnection(config?: DBConfig): Database {
    // If a new config is provided, close existing connection and create new one
    if (config && (this.currentConfig === null || !this.configEquals(config, this.currentConfig))) {
      this.close();
      this.currentConfig = config;
      this.instance = createDB(config);
    }

    // If no instance exists, try to get from config
    if (!this.instance) {
      if (!config) {
        const configManager = new Config();
        const current = configManager.getCurrentDatabase();
        if (!current) {
          throw new Error(
            'No database configured. Use "skibba db:create" or "skibba db:use" to configure a database.'
          );
        }
        config = current.config;
      }
      this.currentConfig = config;
      this.instance = createDB(config);
    }

    return this.instance;
  }

  static close(): void {
    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
      this.currentConfig = null;
    }
  }

  static hasConnection(): boolean {
    return this.instance !== null;
  }
}
