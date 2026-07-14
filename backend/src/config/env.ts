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

  jwt: {
    // Secreto para firmar/verificar los JWT (HS256). Sin valor por defecto a
    // propósito: igual que CERT_ADMIN_KEY, el login/verificación fallan cerrado
    // si no está configurado (nunca se usa un default inseguro).
    secret: process.env.JWT_SECRET || '',
    // Expiración del token; por defecto una jornada laboral.
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },

  // Contraseña temporal del primer admin. El backend siembra el usuario `admin`
  // en el arranque solo si esta variable está definida (con must_change_password).
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || '',

  // Dominio de correo permitido para el autorregistro público (POST /auth/register).
  // Solo se aceptan correos que terminen en `@${allowedSignupDomain}`. Por defecto
  // el dominio corporativo de la cooperativa.
  allowedSignupDomain: process.env.ALLOWED_SIGNUP_DOMAIN || 'coopaspire.com.do',
};
