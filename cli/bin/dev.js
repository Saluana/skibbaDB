#!/usr/bin/env node
import {execute} from '@oclif/core'
import { DBConnection } from '../dist/utils/db-connection.js';

try {
  await execute({development: true, dir: import.meta.url})
} finally {
  // Clean up any open database connections
  if (DBConnection.hasConnection()) {
    DBConnection.close();
  }
  // Force exit after a short delay to ensure cleanup
  setTimeout(() => process.exit(0), 100);
}

