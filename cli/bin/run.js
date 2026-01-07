#!/usr/bin/env node

import {execute} from '@oclif/core'
import { DBConnection } from '../dist/utils/db-connection.js';

try {
  await execute({dir: import.meta.url})
} finally {
  // Clean up any open database connections
  if (DBConnection.hasConnection()) {
    DBConnection.close();
  }
  // Force exit after cleanup delay to handle lingering async operations
  // This is a workaround for async operations (like migrations) that don't
  // provide proper cleanup hooks. In a production CLI, this would ideally
  // be handled by the database library itself.
  setTimeout(() => process.exit(0), 100);
}

