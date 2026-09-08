import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

/** Dominio corporativo obligatorio para el autorregistro (espejo del backend). */
const SIGNUP_DOMAIN = 'coopaspire.com.do';

@Component({
  selector: 'app-register',
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
          <p class="text-ink-soft text-sm m-0">Crea tu cuenta con tu correo corporativo</p>
        </div>

        @if (success()) {
          <!-- Éxito: cuenta pendiente de activación. Sin sesión, solo volver al login. -->
          <div class="ok-box mb-5" role="status">
            <span class="material-icons">check_circle</span>
            <span>{{ success() }}</span>
          </div>
          <a class="btn-cta w-full text-center block no-underline" routerLink="/login">
            Volver al inicio de sesión
          </a>
        } @else {
          <form (ngSubmit)="submit()">
            <label class="field">
              <span class="field-label">Usuario</span>
              <input class="input" name="username" [(ngModel)]="username" autocomplete="username"
                     maxlength="100" [disabled]="loading()" placeholder="p. ej. jperez" autofocus>
            </label>
            <label class="field">
              <span class="field-label">Nombre completo</span>
              <input class="input" name="nombre" [(ngModel)]="nombre" autocomplete="name"
                     maxlength="255" [disabled]="loading()" placeholder="Juan Pérez">
            </label>
            <label class="field">
              <span class="field-label">Correo corporativo</span>
              <input class="input" name="email" type="email" [(ngModel)]="email" autocomplete="email"
                     maxlength="255" [disabled]="loading()" placeholder="tunombre@{{ domain }}">
              <span class="field-hint">Debe terminar en {{ '@' + domain }}</span>
            </label>
            <label class="field">
              <span class="field-label">Contraseña (mínimo 8 caracteres)</span>
              <input class="input" name="password" type="password" [(ngModel)]="password"
                     autocomplete="new-password" [disabled]="loading()" placeholder="••••••••">
            </label>
            <label class="field">
              <span class="field-label">Confirmar contraseña</span>
              <input class="input" name="confirmPassword" type="password" [(ngModel)]="confirmPassword"
                     autocomplete="new-password" [disabled]="loading()" placeholder="••••••••">
            </label>

            @if (error()) {
              <div class="error-box mb-4" role="alert">
                <span class="material-icons">error_outline</span>
                <span>{{ error() }}</span>
              </div>
            }

            <button class="btn-cta w-full" type="submit" [disabled]="!canSubmit() || loading()">
              @if (loading()) { Creando cuenta… } @else { Crear cuenta }
            </button>
          </form>

          <p class="text-center text-sm text-ink-soft mt-5 mb-0">
            ¿Ya tienes cuenta?
            <a routerLink="/login" class="text-cobalt font-medium no-underline">Iniciar sesión</a>
          </p>
        }
      </div>
    </div>
  `,
  styles: [`
    .login-wrap { min-height: 100vh; display:flex; align-items:center; justify-content:center; padding:1.5rem; background:var(--mist); }
    .login-card { width:100%; max-width:420px; }
    .brand-mark { display:inline-block; width:34px; height:40px; background:var(--cobalt); border-radius:6px; clip-path: polygon(0 0, 68% 0, 100% 26%, 100% 100%, 0 100%); }
    .field-label { display:block; font-size:0.85rem; font-weight:600; color:var(--ink); margin-bottom:0.4rem; }
    .field-hint { display:block; font-size:0.78rem; color:var(--ink-soft); margin-top:0.3rem; }
    .w-full { width:100%; }
    .error-box { display:flex; align-items:center; gap:0.6rem; padding:0.8rem 1rem; border-radius:10px; background:var(--danger-soft); color:var(--danger); font-size:0.9rem; }
    .error-box .material-icons { font-size:20px; }
    .ok-box { display:flex; align-items:flex-start; gap:0.6rem; padding:0.9rem 1rem; border-radius:10px; background:var(--ok-soft); color:#0f7b4a; font-size:0.92rem; line-height:1.4; }
    .ok-box .material-icons { font-size:22px; }
  `]
})
export class RegisterComponent {
  readonly domain = SIGNUP_DOMAIN;

  username = '';
  nombre = '';
  email = '';
  password = '';
  confirmPassword = '';

  loading = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  constructor(private auth: AuthService) {}

  private emailHasValidDomain(): boolean {
    return this.email.trim().toLowerCase().endsWith(`@${this.domain.toLowerCase()}`);
  }

  canSubmit(): boolean {
    return (
      this.username.trim().length > 0 &&
      this.nombre.trim().length > 0 &&
      this.email.trim().length > 0 &&
      this.password.length >= 8 &&
      this.confirmPassword.length > 0
    );
  }

  submit(): void {
    if (this.loading()) return;
    this.error.set(null);

    // Validación de cliente antes de tocar la red.
    if (!this.canSubmit()) {
      this.error.set('Completa todos los campos. La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (this.password.length < 8) {
      this.error.set('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (this.password !== this.confirmPassword) {
      this.error.set('Las contraseñas no coinciden.');
      return;
    }
    if (!this.emailHasValidDomain()) {
      this.error.set(`El correo debe pertenecer al dominio ${this.domain}`);
      return;
    }

    this.loading.set(true);
    this.auth
      .register({
        username: this.username.trim(),
        nombre: this.nombre.trim(),
        email: this.email.trim(),
        password: this.password,
      })
      .subscribe({
        next: (res) => {
          this.loading.set(false);
          if (res.success && res.data) {
            this.success.set(res.data.message);
          } else {
            this.error.set(res.error?.message || 'No se pudo crear la cuenta.');
          }
        },
        error: (err) => {
          this.loading.set(false);
          const status = err?.status;
          // El backend responde 400 con { error: { message } } en español.
          const backendMsg = err?.error?.error?.message;
          if (backendMsg) {
            this.error.set(backendMsg);
          } else if (status === 429) {
            this.error.set('Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
          } else {
            this.error.set('No se pudo conectar con el servidor.');
          }
        },
      });
  }
}
