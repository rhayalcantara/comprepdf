// Configuración de PRODUCCIÓN (docker-compose). Se activa con
// `ng build --configuration=production` vía `fileReplacements` de angular.json.
// La API se sirve en el MISMO origen: nginx (frontend/nginx.conf) proxea /api al
// contenedor del backend, así que la URL es relativa y no depende del host ni
// del puerto en que se publique el frontend (3060 en 192.168.113.20).
export const environment = {
  production: true,
  apiUrl: '/api/v1'
};
