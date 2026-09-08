import { createClient, RedisClientType } from 'redis';
import { config } from './env';

let redisClient: RedisClientType;

export const initializeRedis = async (): Promise<RedisClientType> => {
  redisClient = createClient({
    socket: {
      host: config.redis.host,
      port: config.redis.port,
      // Redis es opcional (ya no es broker). No reintentar indefinidamente ni
      // bloquear el arranque: si no conecta al primer intento, connect() rechaza.
      reconnectStrategy: false,
      connectTimeout: 2000,
    },
  });

  redisClient.on('error', (err) => console.error('Redis Client Error:', (err as Error).message));
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
