-- Migración 004: Autorregistro de usuarios con activación por admin.
-- Aplicar sobre instancias existentes. Uso:
--   mysql -u root -p comprepdf < database/migrations/004_user_self_registration.sql
--
-- Añade un TERCER estado de usuario: 'pendiente'. Un usuario que se autorregistra
-- (endpoint público POST /auth/register, restringido al dominio corporativo) nace
-- 'pendiente' y NO puede iniciar sesión hasta que un admin lo pase a 'activo'.
--
-- El DEFAULT sigue siendo 'activo' (para los usuarios que crea el admin y para el
-- seed del primer admin); el autorregistro fija 'pendiente' de forma explícita.

USE comprepdf;

ALTER TABLE users
    MODIFY COLUMN estado ENUM('activo','inactivo','pendiente') NOT NULL DEFAULT 'activo';
