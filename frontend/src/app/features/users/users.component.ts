import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService, CreateUserPayload } from '../../core/services/api.service';
import { AuthService, SafeUser } from '../../core/services/auth.service';

@Component({
  selector: 'app-users',
  standalone: true,
  imports: [CommonModule, FormsModule, MatSnackBarModule],
  template: `
    <div class="max-w-5xl mx-auto pt-8 pb-16">
      <header class="flex flex-wrap items-center gap-4 mb-6">
        <div class="flex-1">
          <h1 class="font-display text-2xl md:text-3xl font-bold m-0">Usuarios</h1>
          <p class="text-ink-soft m-0 mt-1">Gestiona las cuentas del equipo. Solo administradores.</p>
        </div>
        <button class="btn-cta" (click)="toggleCreate()">
          <span class="material-icons">{{ showCreate() ? 'close' : 'person_add' }}</span>
          {{ showCreate() ? 'Cerrar' : 'Nuevo usuario' }}
        </button>
      </header>

      <!-- Contraseña temporal recién generada (mostrar una vez) -->
      @if (tempPassword(); as tp) {
        <div class="temp-box sheet p-5 mb-6">
          <span class="material-icons">vpn_key</span>
          <div class="flex-1">
            <p class="font-medium m-0">Contraseña temporal para <strong>{{ tempUsername() }}</strong></p>
            <p class="text-sm text-ink-soft m-0 mt-1">
              Cópiala ahora: no se volverá a mostrar. El usuario deberá cambiarla al entrar.
            </p>
            <code class="temp-code mono">{{ tp }}</code>
          </div>
          <button class="btn-secondary" (click)="copyTemp(tp)">
            <span class="material-icons" style="font-size:18px">content_copy</span> Copiar
          </button>
          <button class="icon-btn" (click)="dismissTemp()" aria-label="Cerrar">
            <span class="material-icons">close</span>
          </button>
        </div>
      }

      <!-- Formulario de creación -->
      @if (showCreate()) {
        <div class="sheet p-6 md:p-8 mb-6">
          <h2 class="font-display text-lg font-bold m-0 mb-4">Crear usuario</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label class="field">
              <span class="field-label">Usuario *</span>
              <input class="input" [(ngModel)]="newUser.username" maxlength="100" placeholder="p. ej. jperez">
            </label>
            <label class="field">
              <span class="field-label">Nombre *</span>
              <input class="input" [(ngModel)]="newUser.nombre" maxlength="255" placeholder="Juan Pérez">
            </label>
            <label class="field">
              <span class="field-label">Correo</span>
              <input class="input" type="email" [(ngModel)]="newUser.email" maxlength="255" placeholder="opcional">
            </label>
            <label class="field">
              <span class="field-label">Rol</span>
              <select class="input" [(ngModel)]="newUser.rol">
                <option value="user">Usuario</option>
                <option value="admin">Administrador</option>
              </select>
            </label>
          </div>
          <p class="text-sm text-ink-soft mt-2 mb-4">
            Si no defines una contraseña, el sistema generará una temporal que verás una sola vez.
          </p>
          <label class="field">
            <span class="field-label">Contraseña (opcional, mínimo 8)</span>
            <input class="input" type="text" [(ngModel)]="newUser.password" maxlength="200"
                   placeholder="Dejar en blanco para generar una temporal">
          </label>
          <div class="flex justify-end mt-2">
            <button class="btn-cta" [disabled]="!canCreate() || busy()" (click)="create()">
              @if (busy()) { Creando… } @else { Crear usuario }
            </button>
          </div>
        </div>
      }

      <!-- Tabla de usuarios -->
      <div class="sheet p-0 overflow-hidden">
        @if (loading()) {
          <p class="text-ink-soft text-center py-10 m-0">Cargando…</p>
        } @else {
          <div class="table-wrap">
            <table class="users-table">
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Nombre</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  <th class="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                @for (u of users(); track u.id) {
                  <tr>
                    <td>
                      <span class="font-medium">{{ u.username }}</span>
                      @if (isSelf(u)) { <span class="self-tag">tú</span> }
                      @if (u.email) { <span class="block text-sm text-ink-soft">{{ u.email }}</span> }
                    </td>
                    <td>{{ u.nombre }}</td>
                    <td>
                      <select class="mini-select" [ngModel]="u.rol" [disabled]="isSelf(u) || busy()"
                              (ngModelChange)="changeRol(u, $event)">
                        <option value="user">Usuario</option>
                        <option value="admin">Administrador</option>
                      </select>
                    </td>
                    <td>
                      <span class="badge" [class.badge-ok]="u.estado === 'activo'" [class.badge-off]="u.estado !== 'activo'">
                        {{ u.estado }}
                      </span>
                    </td>
                    <td class="text-right actions">
                      @if (u.estado === 'activo') {
                        <button class="link-btn" [disabled]="isSelf(u) || busy()" (click)="setEstado(u, 'inactivo')">
                          Desactivar
                        </button>
                      } @else {
                        <button class="link-btn" [disabled]="busy()" (click)="setEstado(u, 'activo')">
                          Activar
                        </button>
                      }
                      <button class="link-btn" [disabled]="busy()" (click)="resetPassword(u)">
                        Resetear contraseña
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .field-label { display:block; font-size:0.85rem; font-weight:600; color:var(--ink); margin-bottom:0.4rem; }
    .temp-box { display:flex; align-items:flex-start; gap:0.9rem; background:var(--cobalt-soft); border-color:var(--cobalt); }
    .temp-box > .material-icons { color:var(--cobalt-deep); }
    .temp-code { display:inline-block; margin-top:0.5rem; padding:0.35rem 0.7rem; background:#fff; border:1px solid var(--line); border-radius:8px; font-size:0.95rem; letter-spacing:0.02em; }
    .btn-secondary { border:1px solid var(--line); background:var(--paper); color:var(--ink); border-radius:8px; padding:0.5rem 0.9rem; font-weight:600; cursor:pointer; font-family:inherit; white-space:nowrap; display:inline-flex; align-items:center; gap:0.35rem; }
    .btn-secondary:hover { border-color:var(--cobalt); color:var(--cobalt); }
    .table-wrap { overflow-x:auto; }
    .users-table { width:100%; border-collapse:collapse; }
    .users-table th { text-align:left; font-size:0.78rem; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-soft); padding:0.75rem 1rem; border-bottom:1px solid var(--line); white-space:nowrap; }
    .users-table td { padding:0.75rem 1rem; border-bottom:1px solid var(--line); vertical-align:middle; }
    .users-table tbody tr:last-child td { border-bottom:none; }
    .self-tag { display:inline-block; margin-left:0.4rem; padding:0.05rem 0.45rem; border-radius:999px; background:var(--mist); color:var(--ink-soft); font-size:0.7rem; font-weight:600; text-transform:uppercase; }
    .badge { display:inline-block; padding:0.15rem 0.6rem; border-radius:999px; font-size:0.8rem; font-weight:600; text-transform:capitalize; }
    .badge-ok { background:var(--ok-soft); color:#0f7b4a; }
    .badge-off { background:var(--mist); color:var(--ink-soft); }
    .mini-select { padding:0.35rem 1.8rem 0.35rem 0.6rem; border:1px solid var(--line); border-radius:8px; background:var(--paper); font-family:inherit; font-size:0.9rem; cursor:pointer; appearance:none; background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='%2351617d'><path d='M7 10l5 5 5-5z'/></svg>"); background-repeat:no-repeat; background-position:right 0.4rem center; }
    .mini-select:disabled { opacity:0.55; cursor:not-allowed; }
    .actions { white-space:nowrap; }
    .link-btn { background:none; border:none; color:var(--cobalt); font-weight:500; font-size:0.88rem; cursor:pointer; padding:0 0.4rem; font-family:inherit; }
    .link-btn:hover:not(:disabled) { text-decoration:underline; }
    .link-btn:disabled { color:var(--ink-soft); opacity:0.5; cursor:not-allowed; }
  `]
})
export class UsersComponent implements OnInit {
  users = signal<SafeUser[]>([]);
  loading = signal(false);
  busy = signal(false);
  showCreate = signal(false);
  tempPassword = signal<string | null>(null);
  tempUsername = signal<string>('');

  newUser: CreateUserPayload = { username: '', nombre: '', rol: 'user', email: '', password: '' };

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private snackBar: MatSnackBar,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.getUsers().subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.success && res.data) this.users.set(res.data.users);
      },
      error: () => {
        this.loading.set(false);
        this.snackBar.open('No se pudo cargar la lista de usuarios.', 'Cerrar', { duration: 3000 });
      },
    });
  }

  isSelf(u: SafeUser): boolean {
    return u.id === this.auth.user()?.id;
  }

  toggleCreate(): void {
    this.showCreate.update((v) => !v);
  }

  canCreate(): boolean {
    return this.newUser.username.trim().length > 0 && this.newUser.nombre.trim().length > 0;
  }

  create(): void {
    if (!this.canCreate() || this.busy()) return;
    const payload: CreateUserPayload = {
      username: this.newUser.username.trim(),
      nombre: this.newUser.nombre.trim(),
      rol: this.newUser.rol,
    };
    if (this.newUser.email?.trim()) payload.email = this.newUser.email.trim();
    if (this.newUser.password && this.newUser.password.length > 0) payload.password = this.newUser.password;

    this.busy.set(true);
    this.api.createUser(payload).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.success && res.data) {
          if (res.data.temporaryPassword) {
            this.tempPassword.set(res.data.temporaryPassword);
            this.tempUsername.set(res.data.user.username);
          } else {
            this.snackBar.open('Usuario creado.', 'Cerrar', { duration: 2500 });
          }
          this.newUser = { username: '', nombre: '', rol: 'user', email: '', password: '' };
          this.showCreate.set(false);
          this.load();
        }
      },
      error: (err) => {
        this.busy.set(false);
        this.snackBar.open(this.errMsg(err, 'No se pudo crear el usuario.'), 'Cerrar', { duration: 4000 });
      },
    });
  }

  changeRol(u: SafeUser, rol: 'admin' | 'user'): void {
    if (rol === u.rol) return;
    this.patch(u, { rol }, `Rol de ${u.username} actualizado.`);
  }

  setEstado(u: SafeUser, estado: 'activo' | 'inactivo'): void {
    this.patch(u, { estado }, `${u.username} ${estado === 'activo' ? 'activado' : 'desactivado'}.`);
  }

  resetPassword(u: SafeUser): void {
    if (!confirm(`¿Resetear la contraseña de ${u.username}? Se generará una temporal.`)) return;
    const temp = this.randomPassword();
    this.busy.set(true);
    this.api.updateUser(u.id, { newPassword: temp }).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.success) {
          this.tempPassword.set(temp);
          this.tempUsername.set(u.username);
          this.load();
        }
      },
      error: (err) => {
        this.busy.set(false);
        this.snackBar.open(this.errMsg(err, 'No se pudo resetear la contraseña.'), 'Cerrar', { duration: 4000 });
      },
    });
  }

  private patch(u: SafeUser, changes: Parameters<ApiService['updateUser']>[1], okMsg: string): void {
    this.busy.set(true);
    this.api.updateUser(u.id, changes).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.success && res.data) {
          this.snackBar.open(okMsg, 'Cerrar', { duration: 2500 });
          this.load();
        }
      },
      error: (err) => {
        this.busy.set(false);
        // Regla anti-lockout del backend (400) u otros errores.
        this.snackBar.open(this.errMsg(err, 'No se pudo actualizar el usuario.'), 'Cerrar', { duration: 4000 });
        this.load(); // revierte cambios optimistas del select
      },
    });
  }

  copyTemp(tp: string): void {
    navigator.clipboard?.writeText(tp).then(
      () => this.snackBar.open('Contraseña copiada al portapapeles.', 'Cerrar', { duration: 2000 }),
      () => this.snackBar.open('No se pudo copiar automáticamente.', 'Cerrar', { duration: 2500 }),
    );
  }

  dismissTemp(): void {
    this.tempPassword.set(null);
    this.tempUsername.set('');
  }

  /** Contraseña temporal legible generada en el cliente para el reset. */
  private randomPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    return Array.from(arr, (n) => chars[n % chars.length]).join('');
  }

  private errMsg(err: unknown, fallback: string): string {
    const e = err as { error?: { error?: { message?: string } } };
    return e?.error?.error?.message || fallback;
  }
}
