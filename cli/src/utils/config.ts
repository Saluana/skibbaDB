import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DBConfig {
  path?: string;
  memory?: boolean;
  driver?: 'bun' | 'node';
  libsql?: boolean;
  authToken?: string;
  syncUrl?: string;
}

export interface ConfigFile {
  currentDb?: string;
  databases: {
    [name: string]: DBConfig;
  };
}

const CONFIG_DIR = path.join(os.homedir(), '.skibba');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export class Config {
  private config: ConfigFile;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): ConfigFile {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { databases: {} };
    }

    try {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('Failed to load config:', error);
      return { databases: {} };
    }
  }

  private saveConfig(): void {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (error) {
      throw new Error(`Failed to save config: ${error}`);
    }
  }

  setDatabase(name: string, config: DBConfig): void {
    this.config.databases[name] = config;
    this.saveConfig();
  }

  getDatabase(name: string): DBConfig | undefined {
    return this.config.databases[name];
  }

  setCurrentDatabase(name: string): void {
    if (!this.config.databases[name]) {
      throw new Error(`Database "${name}" not found in config`);
    }
    this.config.currentDb = name;
    this.saveConfig();
  }

  getCurrentDatabase(): { name: string; config: DBConfig } | undefined {
    if (!this.config.currentDb) {
      return undefined;
    }
    const config = this.config.databases[this.config.currentDb];
    if (!config) {
      return undefined;
    }
    return { name: this.config.currentDb, config };
  }

  listDatabases(): { name: string; config: DBConfig }[] {
    return Object.entries(this.config.databases).map(([name, config]) => ({
      name,
      config,
    }));
  }

  removeDatabase(name: string): void {
    delete this.config.databases[name];
    if (this.config.currentDb === name) {
      delete this.config.currentDb;
    }
    this.saveConfig();
  }

  clearAll(): void {
    this.config = { databases: {} };
    this.saveConfig();
  }
}
