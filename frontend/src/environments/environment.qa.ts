// Configuración de QA. Se activa con `ng build --configuration=qa` mediante el
// `fileReplacements` de angular.json (reemplaza environment.ts). Así el build de
// QA apunta a la API de la máquina QA sin editar environment.ts a mano.
export const environment = {
  production: true,
  apiUrl: 'http://192.168.7.222:3000/api/v1'
};
