import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService, CreateUserPayload, Pagination, UpdateUserPayload } from '../../core/services/api.service';
import { AuthService, SafeUser } from '../../core/services/auth.service';

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

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
        @if (pendingCount() > 0) {
          <span class="pending-pill" title="Cuentas pendientes de activación">
            <span class="material-icons" style="font-size:18px">hourglass_top</span>
            {{ pendingCount() }} pendiente{{ pendingCount() === 1 ? '' : 's' }} de activación
          </span>
        }
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
        <!-- Filtros -->
        <div class="filters">
          <div class="search-box">
            <span class="material-icons">search</span>
            <input class="search-input" type="search" maxlength="100"
                   placeholder="Buscar por usuario, nombre o correo"
                   [ngModel]="filterQ" (ngModelChange)="onSearchChange($event)">
          </div>
          <select class="mini-select" [(ngModel)]="filterRol" (ngModelChange)="onFilterChange()">
            <option value="">Todos los roles</option>
            <option value="admin">Administrador</option>
            <option value="user">Usuario</option>
          </select>
          <select class="mini-select" [(ngModel)]="filterEstado" (ngModelChange)="onFilterChange()">
            <option value="">Todos los estados</option>
            <option value="activo">Activo</option>
            <option value="pendiente">Pendiente</option>
            <option value="inactivo">Inactivo</option>
          </select>
          @if (hasFilters()) {
            <button class="link-btn" (click)="clearFilters()">Limpiar filtros</button>
          }
        </div>

        @if (loading()) {
          <p class="text-ink-soft text-center py-10 m-0">Cargando…</p>
        } @else if (users().length === 0) {
          <div class="text-center py-10">
            <p class="text-ink-soft m-0">
              @if (hasFilters()) {
                Ningún usuario coincide con los filtros.
              } @else {
                No hay usuarios.
              }
            </p>
            @if (hasFilters()) {
              <button class="link-btn mt-2" (click)="clearFilters()">Limpiar filtros</button>
            }
          </div>
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
                  <tr [class.row-pending]="u.estado === 'pendiente'">
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
                      <span class="badge"
                            [class.badge-ok]="u.estado === 'activo'"
                            [class.badge-pending]="u.estado === 'pendiente'"
                            [class.badge-off]="u.estado === 'inactivo'">
                        {{ u.estado }}
                      </span>
                    </td>
                    <td class="text-right actions">
                      @if (u.estado === 'pendiente') {
                        <button class="btn-activate" [disabled]="busy()" (click)="setEstado(u, 'activo')">
                          <span class="material-icons" style="font-size:16px">check</span> Activar
                        </button>
                      } @else if (u.estado === 'activo') {
                        <button class="link-btn" [disabled]="isSelf(u) || busy()" (click)="setEstado(u, 'inactivo')">
                          Desactivar
                        </button>
                      } @else {
                        <button class="link-btn" [disabled]="busy()" (click)="setEstado(u, 'activo')">
                          Activar
                        </button>
                      }
                      <button class="link-btn" [disabled]="busy()" (click)="openEdit(u)">
                        Editar
                      </button>
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

        <!-- Paginación (mismo patrón que "Mis trabajos") -->
        @if (pagination(); as p) {
          @if (p.total > 0) {
            <div class="pager">
              <span class="text-sm text-ink-soft">
                {{ p.total }} usuario(s) · página {{ p.page }} de {{ p.totalPages || 1 }}
              </span>
              <div class="flex gap-2">
                <button class="btn-secondary" [disabled]="p.page <= 1 || loading()" (click)="goto(p.page - 1)">
                  Anterior
                </button>
                <button class="btn-secondary" [disabled]="p.page >= p.totalPages || loading()" (click)="goto(p.page + 1)">
                  Siguiente
                </button>
              </div>
            </div>
          }
        }
      </div>

      <!-- Modal: editar usuario -->
      @if (editingUser(); as eu) {
        <div class="modal-backdrop" (click)="closeEdit()">
          <div class="modal-card sheet p-6 md:p-8" (click)="$event.stopPropagation()">
            <div class="flex items-center justify-between mb-4">
              <h2 class="font-display text-lg font-bold m-0">Editar {{ eu.username }}</h2>
              <button class="icon-btn" (click)="closeEdit()" aria-label="Cerrar">
                <span class="material-icons">close</span>
              </button>
            </div>
            <div class="grid grid-cols-1 gap-4">
              <label class="field">
                <span class="field-label">Usuario *</span>
                <input class="input" [(ngModel)]="editModel.username" maxlength="100"
                       placeholder="p. ej. jperez">
                <span class="hint">Es lo que teclea para entrar. También puede entrar con su correo.</span>
              </label>
              <label class="field">
                <span class="field-label">Nombre *</span>
                <input class="input" [(ngModel)]="editModel.nombre" maxlength="255">
              </label>
              <label class="field">
                <span class="field-label">Correo</span>
                <input class="input" type="email" [(ngModel)]="editModel.email" maxlength="255"
                       placeholder="Dejar en blanco para quitar el correo">
              </label>
            </div>
            <p class="text-sm text-ink-soft mt-3 m-0">
              Para rol, estado o contraseña usa las acciones de la tabla.
            </p>
            <div class="flex justify-end gap-2 mt-5">
              <button class="btn-secondary" [disabled]="busy()" (click)="closeEdit()">Cancelar</button>
              <button class="btn-cta" [disabled]="!canSaveEdit() || busy()" (click)="saveEdit()">
                @if (busy()) { Guardando… } @else { Guardar cambios }
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .field-label { display:block; font-size:0.85rem; font-weight:600; color:var(--ink); margin-bottom:0.4rem; }
    .hint { display:block; font-size:0.8rem; color:var(--ink-soft); margin-top:0.35rem; }
    .temp-box { display:flex; align-items:flex-start; gap:0.9rem; background:var(--cobalt-soft); border-color:var(--cobalt); }
    .temp-box > .material-icons { color:var(--cobalt-deep); }
    .temp-code { display:inline-block; margin-top:0.5rem; padding:0.35rem 0.7rem; background:#fff; border:1px solid var(--line); border-radius:8px; font-size:0.95rem; letter-spacing:0.02em; }
    .btn-secondary { border:1px solid var(--line); background:var(--paper); color:var(--ink); border-radius:8px; padding:0.5rem 0.9rem; font-weight:600; cursor:pointer; font-family:inherit; white-space:nowrap; display:inline-flex; align-items:center; gap:0.35rem; }
    .btn-secondary:hover { border-color:var(--cobalt); color:var(--cobalt); }
    .filters { display:flex; align-items:center; gap:0.6rem; padding:0.85rem 1rem; border-bottom:1px solid var(--line); flex-wrap:wrap; }
    .search-box { display:flex; align-items:center; gap:0.4rem; flex:1; min-width:14rem; border:1px solid var(--line); border-radius:8px; padding:0.35rem 0.6rem; background:var(--paper); }
    .search-box .material-icons { font-size:18px; color:var(--ink-soft); }
    .search-input { border:none; outline:none; background:transparent; flex:1; font-family:inherit; font-size:0.9rem; color:var(--ink); }
    .pager { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:0.85rem 1rem; border-top:1px solid var(--line); flex-wrap:wrap; }
    .table-wrap { overflow-x:auto; }
    .users-table { width:100%; border-collapse:collapse; }
    .users-table th { text-align:left; font-size:0.78rem; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-soft); padding:0.75rem 1rem; border-bottom:1px solid var(--line); white-space:nowrap; }
    .users-table td { padding:0.75rem 1rem; border-bottom:1px solid var(--line); vertical-align:middle; }
    .users-table tbody tr:last-child td { border-bottom:none; }
    .self-tag { display:inline-block; margin-left:0.4rem; padding:0.05rem 0.45rem; border-radius:999px; background:var(--mist); color:var(--ink-soft); font-size:0.7rem; font-weight:600; text-transform:uppercase; }
    .badge { display:inline-block; padding:0.15rem 0.6rem; border-radius:999px; font-size:0.8rem; font-weight:600; text-transform:capitalize; }
    .badge-ok { background:var(--ok-soft); color:#0f7b4a; }
    .badge-pending { background:#fff4e0; color:#b45309; }
    .badge-off { background:var(--mist); color:var(--ink-soft); }
    .row-pending { background:#fffaf0; }
    .pending-pill { display:inline-flex; align-items:center; gap:0.35rem; padding:0.35rem 0.8rem; border-radius:999px; background:#fff4e0; color:#b45309; font-size:0.85rem; font-weight:600; }
    .btn-activate { display:inline-flex; align-items:center; gap:0.25rem; padding:0.35rem 0.8rem; border:none; border-radius:8px; background:#0f7b4a; color:#fff; font-weight:600; font-size:0.85rem; cursor:pointer; font-family:inherit; margin-right:0.4rem; }
    .btn-activate:hover:not(:disabled) { background:#0c6640; }
    .btn-activate:disabled { opacity:0.55; cursor:not-allowed; }
    .mini-select { padding:0.35rem 1.8rem 0.35rem 0.6rem; border:1px solid var(--line); border-radius:8px; background:var(--paper); font-family:inherit; font-size:0.9rem; cursor:pointer; appearance:none; background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='%2351617d'><path d='M7 10l5 5 5-5z'/></svg>"); background-repeat:no-repeat; background-position:right 0.4rem center; }
    .mini-select:disabled { opacity:0.55; cursor:not-allowed; }
    .actions { white-space:nowrap; }
    .link-btn { background:none; border:none; color:var(--cobalt); font-weight:500; font-size:0.88rem; cursor:pointer; padding:0 0.4rem; font-family:inherit; }
    .link-btn:hover:not(:disabled) { text-decoration:underline; }
    .link-btn:disabled { color:var(--ink-soft); opacity:0.5; cursor:not-allowed; }
    .modal-backdrop { position:fixed; inset:0; background:rgba(15,23,42,0.45); display:flex; align-items:center; justify-content:center; padding:1rem; z-index:50; }
    .modal-card { width:100%; max-width:30rem; background:var(--paper); }
  `]
})
export class UsersComponent implements OnInit, OnDestroy {
  users = signal<SafeUser[]>([]);
  pagination = signal<Pagination | null>(null);
  /** Total GLOBAL de pendientes (lo trae el backend; ignora página y filtros). */
  pendingCount = signal(0);
  loading = signal(false);

  // Filtros (el orden pendientes-primero lo aplica el backend)
  filterQ = '';
  filterRol = '';
  filterEstado = '';
  private page = signal(1);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  busy = signal(false);
  showCreate = signal(false);
  tempPassword = signal<string | null>(null);
  tempUsername = signal<string>('');

  newUser: CreateUserPayload = { username: '', nombre: '', rol: 'user', email: '', password: '' };

  editingUser = signal<SafeUser | null>(null);
  editModel: { username: string; nombre: string; email: string } = { username: '', nombre: '', email: '' };

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private snackBar: MatSnackBar,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  ngOnDestroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  load(): void {
    this.loading.set(true);
    const filters = { rol: this.filterRol, estado: this.filterEstado, q: this.filterQ };
    this.api.getUsers(this.page(), PAGE_SIZE, filters).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.success && res.data) {
          this.users.set(res.data.users);
          this.pagination.set(res.data.pagination);
          this.pendingCount.set(res.data.pendingTotal);
          // Página fuera de rango (p. ej. tras borrar filtros o desactivar el
          // último de la página): retrocede a la última con contenido.
          const p = res.data.pagination;
          if (p.page > 1 && res.data.users.length === 0 && p.total > 0) {
            this.goto(p.totalPages);
          }
        }
      },
      error: () => {
        this.loading.set(false);
        this.snackBar.open('No se pudo cargar la lista de usuarios.', 'Cerrar', { duration: 3000 });
      },
    });
  }

  onSearchChange(value: string): void {
    this.filterQ = value;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      this.load();
    }, SEARCH_DEBOUNCE_MS);
  }

  onFilterChange(): void {
    this.page.set(1);
    this.load();
  }

  hasFilters(): boolean {
    return !!(this.filterQ.trim() || this.filterRol || this.filterEstado);
  }

  clearFilters(): void {
    this.filterQ = '';
    this.filterRol = '';
    this.filterEstado = '';
    this.page.set(1);
    this.load();
  }

  goto(page: number): void {
    if (page < 1) return;
    this.page.set(page);
    this.load();
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

  openEdit(u: SafeUser): void {
    this.editModel = { username: u.username, nombre: u.nombre, email: u.email ?? '' };
    this.editingUser.set(u);
  }

  closeEdit(): void {
    this.editingUser.set(null);
  }

  canSaveEdit(): boolean {
    return this.editModel.username.trim().length > 0 && this.editModel.nombre.trim().length > 0;
  }

  saveEdit(): void {
    const u = this.editingUser();
    if (!u || !this.canSaveEdit() || this.busy()) return;

    const changes: UpdateUserPayload = {};
    const username = this.editModel.username.trim();
    const nombre = this.editModel.nombre.trim();
    const email = this.editModel.email.trim();
    if (username !== u.username) changes.username = username;
    if (nombre !== u.nombre) changes.nombre = nombre;
    // '' se envía tal cual; el backend lo convierte a null (quita el correo).
    if (email !== (u.email ?? '')) changes.email = email;

    if (Object.keys(changes).length === 0) {
      this.closeEdit();
      return;
    }

    this.busy.set(true);
    this.api.updateUser(u.id, changes).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.success && res.data) {
          const renamed = res.data.user.username !== u.username;
          this.snackBar.open(
            renamed
              ? `${u.username} ahora inicia sesión como ${res.data.user.username}.`
              : `${u.username} actualizado.`,
            'Cerrar',
            { duration: renamed ? 5000 : 2500 },
          );
          // Si el admin se renombró a sí mismo, la sesión guarda el nombre viejo.
          if (renamed && this.isSelf(u)) this.auth.refreshMe().subscribe();
          this.closeEdit();
          this.load();
        }
      },
      error: (err) => {
        this.busy.set(false);
        this.snackBar.open(this.errMsg(err, 'No se pudo actualizar el usuario.'), 'Cerrar', { duration: 4000 });
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
