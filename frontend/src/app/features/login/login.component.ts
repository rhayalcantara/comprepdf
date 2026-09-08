import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="login-wrap">
      <div class="sheet login-card p-8">
        <div class="text-center mb-6">
          <span class="brand-mark" aria-hidden="true"></span>
          <h1 class="font-display font-bold text-2xl mt-3 mb-1">
            Compre<span class="text-cobalt">PDF</span>
          </h1>
          <p class="text-ink-soft text-sm m-0">Herramienta interna — inicia sesión para continuar</p>
        </div>

        <form (ngSubmit)="submit()">
          <label class="field">
            <span class="field-label">Usuario o correo</span>
            <input class="input" name="username" [(ngModel)]="username" autocomplete="username"
                   [disabled]="loading()" placeholder="usuario o correo" autofocus>
          </label>
          <label class="field">
            <span class="field-label">Contraseña</span>
            <input class="input" name="password" type="password" [(ngModel)]="password"
                   autocomplete="current-password" [disabled]="loading()" placeholder="••••••••">
          </label>

          @if (error()) {
            <div class="error-box mb-4" role="alert">
              <span class="material-icons">error_outline</span>
              <span>{{ error() }}</span>
            </div>
          }

          <button class="btn-cta w-full" type="submit" [disabled]="!canSubmit() || loading()">
            @if (loading()) { Entrando… } @else { Iniciar sesión }
          </button>
        </form>

        <p class="text-center text-sm text-ink-soft mt-5 mb-0">
          ¿No tienes cuenta?
          <a routerLink="/registro" class="text-cobalt font-medium no-underline">Crear cuenta</a>
        </p>
      </div>
    </div>
  `,
  styles: [`
    .login-wrap { min-height: 100vh; display:flex; align-items:center; justify-content:center; padding:1.5rem; background:var(--mist); }
    .login-card { width:100%; max-width:400px; }
    .brand-mark { display:inline-block; width:34px; height:40px; background:var(--cobalt); border-radius:6px; clip-path: polygon(0 0, 68% 0, 100% 26%, 100% 100%, 0 100%); }
    .field-label { display:block; font-size:0.85rem; font-weight:600; color:var(--ink); margin-bottom:0.4rem; }
    .w-full { width:100%; }
    .error-box { display:flex; align-items:center; gap:0.6rem; padding:0.8rem 1rem; border-radius:10px; background:var(--danger-soft); color:var(--danger); font-size:0.9rem; }
    .error-box .material-icons { font-size:20px; }
  `]
})
export class LoginComponent {
  username = '';
  password = '';
  loading = signal(false);
  error = signal<string | null>(null);

  constructor(private auth: AuthService, private router: Router) {}

  canSubmit(): boolean {
    return this.username.trim().length > 0 && this.password.length > 0;
  }

  submit(): void {
    if (!this.canSubmit() || this.loading()) return;
    this.loading.set(true);
    this.error.set(null);

    this.auth.login(this.username.trim(), this.password).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.success && res.data) {
          // Cambio de contraseña obligatorio antes de entrar al resto de la app.
          if (res.data.user.mustChangePassword) {
            this.router.navigate(['/cambiar-contrasena']);
          } else {
            this.router.navigate(['/']);
          }
        } else {
          this.error.set(res.error?.message || 'No se pudo iniciar sesión');
        }
      },
      error: (err) => {
        this.loading.set(false);
        const status = err?.status;
        // El backend distingue estado 'pendiente' de 'inactivo' con su propio
        // mensaje en el 403; lo mostramos tal cual (no como credenciales malas).
        const backendMsg = err?.error?.error?.message;
        if (status === 401) {
          this.error.set('Usuario o contraseña incorrectos.');
        } else if (status === 403) {
          this.error.set(backendMsg || 'Tu cuenta está inactiva. Contacta al administrador.');
        } else if (status === 503) {
          this.error.set('La autenticación no está configurada en el servidor.');
        } else if (status === 429) {
          this.error.set('Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
        } else {
          this.error.set('No se pudo conectar con el servidor.');
        }
      },
    });
  }
}
