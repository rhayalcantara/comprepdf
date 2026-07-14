import { DataSource } from 'typeorm';
import { config } from './env';
import { CompressionJob } from '../models/job.model';
import { File } from '../models/file.model';
import { CompressionStats } from '../models/stats.model';
import { Certificate } from '../models/certificate.model';
import { User } from '../models/user.model';

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: config.mysql.host,
  port: config.mysql.port,
  username: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  synchronize: false,
  logging: config.nodeEnv === 'development',
  entities: [CompressionJob, File, CompressionStats, Certificate, User],
  migrations: [],
  subscribers: [],
});

export const initializeDatabase = async (): Promise<void> => {
  try {
    await AppDataSource.initialize();
    console.log('Database connection established');
  } catch (error) {
    console.error('Database connection failed:', error);
    throw error;
  }
};
