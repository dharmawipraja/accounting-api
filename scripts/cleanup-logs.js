#!/usr/bin/env node

/**
 * Log cleanup utility
 * Manually clean up old log files based on retention policy
 */

/* eslint-disable no-console */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../src/config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGS_DIR = path.join(__dirname, 'logs');
const RETENTION_DAYS = env.LOG_RETENTION_DAYS;

async function cleanupOldLogs() {
  try {
    console.log(`Starting log cleanup with ${RETENTION_DAYS} days retention...`);

    // Check if logs directory exists
    try {
      await fs.access(LOGS_DIR);
    } catch {
      console.log('Logs directory does not exist. Nothing to clean up.');
      return;
    }

    // Read log files
    const files = await fs.readdir(LOGS_DIR);
    const logFiles = files.filter(file => file.match(/^app-\d{4}-\d{2}-\d{2}\.log$/));

    if (logFiles.length === 0) {
      console.log('No log files found to clean up.');
      return;
    }

    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

    let deletedCount = 0;

    for (const logFile of logFiles) {
      // Extract date from filename (app-YYYY-MM-DD.log)
      const dateMatch = logFile.match(/app-(\d{4}-\d{2}-\d{2})\.log/);
      if (!dateMatch) continue;

      const fileDate = new Date(dateMatch[1]);

      if (fileDate < cutoffDate) {
        const filePath = path.join(LOGS_DIR, logFile);
        try {
          await fs.unlink(filePath);
          console.log(`Deleted old log file: ${logFile}`);
          deletedCount++;
        } catch (error) {
          console.error(`Failed to delete ${logFile}:`, error.message);
        }
      }
    }

    console.log(`Log cleanup completed. Deleted ${deletedCount} old log files.`);
  } catch (error) {
    console.error('Error during log cleanup:', error.message);
    process.exit(1);
  }
}

// Run cleanup if this script is executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cleanupOldLogs();
}

export { cleanupOldLogs };
