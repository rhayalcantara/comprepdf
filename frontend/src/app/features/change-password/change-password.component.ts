import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-change-password',
  standalone: true,
  imports: [CommonModule, FormsModule, MatSnackBarModule],
  template: `
    <div class="max-w-md mx-auto pt-10 pb-16">
      <header class="mb-6">
        <h1 class="font-display text-2xl font-bold m-0">Cambiar contraseña</h1>
        @if (mandatory()) {
          <p class="text-ink-soft m-0 mt-2">
            Por seguridad, debes establecer una contraseña nueva antes de continuar.
          </p>
        } @else {
          <p class="text-ink-soft m-0 mt-2">Actualiza tu contraseña de acceso.</p>
        }
      </header>

      <div class="sheet p-6 md:p-8">
        <form (ngSubmit)="submit()">
          <label class="field">
            <span class="field-label">Contraseña actual</span>
            <input class="input" name="current" type="password" [(ngModel)]="currentPassword"
                   autocomplete="current-password" [disabled]="loading()">
          </label>
          <label class="field">
            <span class="field-label">Nueva contraseña (mínimo 8 caracteres)</span>
            <input class="input" name="new" type="password" [(ngModel)]="newPassword"
                   autocomplete="new-password" [disabled]="loading()">
          </label>
          <label class="field">
            <span class="field-label">Confirmar nueva contraseña</span>
            <input class="input" name="confirm" type="password" [(ngModel)]="confirmPassword"
                   autocomplete="new-password" [disabled]="loading()">
          </label>

          @if (error()) {
            <div class="error-box mb-4" role="alert">
              <span class="material-icons">error_outline</span>
              <span>{{ error() }}</span>
            </div>
          }

          <div class="flex justify-end gap-2 mt-2">
            @if (!mandatory()) {
              <button type="button" class="btn-ghost" (click)="cancel()" [disabled]="loading()">Cancelar</button>
            }
            <button class="btn-cta" type="submit" [disabled]="!canSubmit() || loading()">
              @if (loading()) { Guardando… } @else { Cambiar contraseña }
            </button>
          </div>
        </form>
      </div>
    </div>
  `,
  styles: [`
    .field-label { display:block; font-size:0.85rem; font-weight:600; color:var(--ink); margin-bottom:0.4rem; }
    .error-box { display:flex; align-items:center; gap:0.6rem; padding:0.8rem 1rem; border-radius:10px; background:var(--danger-soft); color:var(--danger); font-size:0.9rem; }
    .error-box .material-icons { font-size:20px; }
  `]
})
export class ChangePasswordComponent {
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  loading = signal(false);
  error = signal<string | null>(null);

  /** Cuando el backend forzó el cambio: se oculta "Cancelar" y se redirige a home al terminar. */
  mandatory: AuthService['mustChangePassword'];

  constructor(
    private auth: AuthService,
    private router: Router,
    private snackBar: MatSnackBar,
  ) {
    this.mandatory = this.auth.mustChangePassword;
  }

  canSubmit(): boolean {
    return (
      this.currentPassword.length > 0 &&
      this.newPassword.length >= 8 &&
      this.confirmPassword.length > 0
    );
  }

  submit(): void {
    if (this.loading()) return;
    this.error.set(null);

    if (this.newPassword.length < 8) {
      this.error.set('La nueva contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.error.set('Las contraseñas no coinciden.');
      return;
    }

    this.loading.set(true);
    this.auth.changePassword(this.currentPassword, this.newPassword).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.success) {
          this.snackBar.open('Contraseña actualizada.', 'Cerrar', { duration: 3000 });
          this.router.navigate(['/']);
        } else {
          this.error.set(res.error?.message || 'No se pudo cambiar la contraseña.');
        }
      },
      error: (err) => {
        this.loading.set(false);
        if (err?.status === 401) {
          this.error.set('La contraseña actual es incorrecta.');
        } else {
          this.error.set('No se pudo cambiar la contraseña.');
        }
      },
    });
  }

  cancel(): void {
    this.router.navigate(['/']);
  }
}
