import { asValue } from 'awilix';
import prisma from '../lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { LogBuffer } from '../lib/log-buffer';
import { env } from '../config/env';

// Shared in-memory log ring buffer, fed by the request logger and the SQL
// console audit trail, read by the Console Logs screen.
export const logBuffer = new LogBuffer(env.CONSOLE_LOG_BUFFER_SIZE);

export interface IModelContainer {
  prisma: PrismaClient;
  logBuffer: LogBuffer;
}

export default {
  prisma: asValue(prisma),
  logBuffer: asValue(logBuffer),
};
