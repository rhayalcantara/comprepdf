import { Injectable, computed, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from './api.service';

/** Perfil seguro del usuario (sin passwordHash). Espejo de `SafeUser` del backend. */
export interface SafeUser {
  id: string;
  username: string;
  email: string | null;
  nombre: string;
  rol: 'admin' | 'user';
  estado: 'activo' | 'inactivo' | 'pendiente';
  authProvider: 'local' | 'ad';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LoginData {
  token: string;
  user: SafeUser;
}

const TOKEN_KEY = 'comprepdf_token';
const USER_KEY = 'comprepdf_user';

/**
 * Servicio de autenticación. Mantiene el usuario y el token en signals + localStorage,
 * decodifica la expiración del JWT y hace auto-logout cuando el token expira.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly baseUrl = environment.apiUrl;

  /** Usuario actual (null si no hay sesión). */
  readonly user = signal<SafeUser | null>(null);
  readonly isAuthenticated = computed(() => this.user() !== null);
  readonly isAdmin = computed(() => this.user()?.rol === 'admin');
  /** El usuario debe cambiar su contraseña antes de usar el resto de la app. */
  readonly mustChangePassword = computed(() => this.user()?.mustChangePassword === true);

  private token: string | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private http: HttpClient) {
    this.hydrateFromStorage();
  }

  /** Token actual (para el interceptor). */
  getToken(): string | null {
    return this.token;
  }

  /** Rehidrata sesión desde localStorage al arrancar; auto-logout si el token expiró. */
  private hydrateFromStorage(): void {
    const token = localStorage.getItem(TOKEN_KEY);
    const rawUser = localStorage.getItem(USER_KEY);
    if (!token || !rawUser) {
      this.clearSession();
      return;
    }
    const exp = this.tokenExpiryMs(token);
    if (exp === null || exp <= Date.now()) {
      // Token ausente de exp o ya expirado: sesión inválida.
      this.clearSession();
      return;
    }
    try {
      this.token = token;
      this.user.set(JSON.parse(rawUser) as SafeUser);
      this.scheduleAutoLogout(exp);
    } catch {
      this.clearSession();
    }
  }

  login(username: string, password: string): Observable<ApiResponse<LoginData>> {
    return this.http
      .post<ApiResponse<LoginData>>(`${this.baseUrl}/auth/login`, { username, password })
      .pipe(
        tap((res) => {
          if (res.success && res.data) {
            this.setSession(res.data.token, res.data.user);
          }
        }),
      );
  }

  /**
   * Autorregistro público (sin token). La cuenta nace `pendiente` y NO hay
   * auto-login: no se guarda token ni user. Devuelve el mensaje de éxito del
   * backend; propaga el error para que el componente muestre su `message`.
   */
  register(payload: {
    username: string;
    nombre: string;
    email: string;
    password: string;
  }): Observable<ApiResponse<{ message: string }>> {
    return this.http.post<ApiResponse<{ message: string }>>(
      `${this.baseUrl}/auth/register`,
      payload,
    );
  }

  /** Cambio de contraseña propio. Al éxito, limpia `mustChangePassword` localmente. */
  changePassword(currentPassword: string, newPassword: string): Observable<ApiResponse<{ message: string }>> {
    return this.http
      .post<ApiResponse<{ message: string }>>(`${this.baseUrl}/auth/change-password`, {
        currentPassword,
        newPassword,
      })
      .pipe(
        tap((res) => {
          if (res.success) {
            const current = this.user();
            if (current) {
              const updated = { ...current, mustChangePassword: false };
              this.user.set(updated);
              localStorage.setItem(USER_KEY, JSON.stringify(updated));
            }
          }
        }),
      );
  }

  /** Recarga el perfil desde /auth/me (por si cambió en el servidor). */
  refreshMe(): Observable<ApiResponse<{ user: SafeUser }>> {
    return this.http.get<ApiResponse<{ user: SafeUser }>>(`${this.baseUrl}/auth/me`).pipe(
      tap((res) => {
        if (res.success && res.data) {
          this.user.set(res.data.user);
          localStorage.setItem(USER_KEY, JSON.stringify(res.data.user));
        }
      }),
    );
  }

  logout(): void {
    this.clearSession();
  }

  private setSession(token: string, user: SafeUser): void {
    this.token = token;
    this.user.set(user);
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    const exp = this.tokenExpiryMs(token);
    if (exp) this.scheduleAutoLogout(exp);
  }

  private clearSession(): void {
    this.token = null;
    this.user.set(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /** Programa el auto-logout justo cuando el token expira. */
  private scheduleAutoLogout(expiryMs: number): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const delay = expiryMs - Date.now();
    if (delay <= 0) {
      this.clearSession();
      return;
    }
    // setTimeout tope ~24.8 días; nuestros JWT duran 8h, sin problema.
    this.expiryTimer = setTimeout(() => this.clearSession(), delay);
  }

  /** Devuelve la expiración (ms epoch) del JWT, o null si no se puede leer. */
  private tokenExpiryMs(token: string): number | null {
    const payload = this.decodeJwtPayload(token);
    if (!payload || typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  }

  private decodeJwtPayload(token: string): { exp?: number; sub?: string; rol?: string } | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = atob(base64);
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
}
