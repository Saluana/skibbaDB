export class ValidationError extends Error {
  constructor(message: string, public details?: any) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class UniqueConstraintError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = 'UniqueConstraintError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string, public id?: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class DatabaseError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class PluginError extends Error {
  constructor(
    message: string, 
    public pluginName: string,
    public hookName: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export class PluginTimeoutError extends PluginError {
  constructor(
    pluginName: string,
    hookName: string,
    timeout: number
  ) {
    super(
      `Plugin '${pluginName}' hook '${hookName}' timed out after ${timeout}ms`,
      pluginName,
      hookName
    );
    this.name = 'PluginTimeoutError';
  }
}

export class VersionMismatchError extends Error {
  constructor(
    message: string, 
    public id: string,
    public expectedVersion: number,
    public actualVersion: number
  ) {
    super(message);
    this.name = 'VersionMismatchError';
  }
}