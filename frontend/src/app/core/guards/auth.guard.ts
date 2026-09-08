import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Protege toda ruta salvo /login. Si no hay sesión, redirige a /login.
 * Si el usuario debe cambiar su contraseña, lo fuerza a /cambiar-contrasena
 * antes de dejarle entrar al resto de la app.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login']);
  }

  // Cambio de contraseña obligatorio: bloquea todo excepto la propia pantalla.
  if (auth.mustChangePassword() && state.url !== '/cambiar-contrasena') {
    return router.createUrlTree(['/cambiar-contrasena']);
  }

  return true;
};
