import { Queue } from 'bullmq';
import { config } from '../config/env';

let compressionQueue: Queue;

export const initializeQueue = (): Queue => {
  compressionQueue = new Queue('compression', {
    connection: {
      host: config.redis.host,
      port: config.redis.port,
    },
  });

  return compressionQueue;
};

export const getCompressionQueue = (): Queue => {
  if (!compressionQueue) {
    throw new Error('Queue not initialized');
  }
  return compressionQueue;
};

export const addCompressionJob = async (jobId: string, data: Record<string, unknown>): Promise<void> => {
  const queue = getCompressionQueue();
  await queue.add('compress-pdf', { jobId, ...data }, {
    jobId,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000,
    },
  });
};
