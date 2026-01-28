import chalk from 'chalk';

export function formatSuccess(message: string): string {
  return chalk.green('✓ ') + message;
}

export function formatError(message: string): string {
  return chalk.red('✗ ') + message;
}

export function formatWarning(message: string): string {
  return chalk.yellow('⚠ ') + message;
}

export function formatInfo(message: string): string {
  return chalk.blue('ℹ ') + message;
}

export function formatTable(data: any[]): string {
  if (data.length === 0) {
    return 'No data';
  }

  const keys = Object.keys(data[0]);
  const maxLengths = keys.map((key) =>
    Math.max(
      key.length,
      ...data.map((item) => String(item[key] || '').length)
    )
  );

  const header = keys
    .map((key, i) => chalk.bold(key.padEnd(maxLengths[i])))
    .join(' │ ');
  const separator = maxLengths.map((len) => '─'.repeat(len)).join('─┼─');

  const rows = data.map((item) =>
    keys.map((key, i) => String(item[key] || '').padEnd(maxLengths[i])).join(' │ ')
  );

  return [header, separator, ...rows].join('\n');
}

export function formatJSON(data: any, pretty = true): string {
  return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 3) + '...';
}
