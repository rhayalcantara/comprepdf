import { createClient, RedisClientType } from 'redis';
import { config } from './env';

let redisClient: RedisClientType;

export const initializeRedis = async (): Promise<RedisClientType> => {
  redisClient = createClient({
    socket: {
      host: config.redis.host,
      port: config.redis.port,
    },
  });

  redisClient.on('error', (err) => console.error('Redis Client Error:', err));
  redisClient.on('connect', () => console.log('Redis connection established'));

  await redisClient.connect();
  return redisClient;
};

export const getRedisClient = (): RedisClientType => {
  if (!redisClient) {
    throw new Error('Redis client not initialized');
  }
  return redisClient;
};
