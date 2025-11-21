import dotenv from 'dotenv';

dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  mysql: {
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    database: process.env.MYSQL_DATABASE || 'comprepdf',
    user: process.env.MYSQL_USER || 'comprepdf',
    password: process.env.MYSQL_PASSWORD || 'comprepdf123',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  upload: {
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10),
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    outputDir: process.env.OUTPUT_DIR || './outputs',
    fileExpiryHours: parseInt(process.env.FILE_EXPIRY_HOURS || '24', 10),
  },
};
