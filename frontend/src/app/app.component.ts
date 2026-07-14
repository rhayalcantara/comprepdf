import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { MatMenuModule } from '@angular/material/menu';
import { filter } from 'rxjs';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, MatMenuModule],
  template: `
    @if (showChrome()) {
      <header class="border-b border-line bg-white sticky top-0 z-50">
        <div class="container flex flex-wrap items-center gap-x-6 py-3">
          <a routerLink="/" class="flex items-center gap-2 no-underline">
            <span class="brand-mark" aria-hidden="true"></span>
            <span class="font-display font-bold text-xl text-ink">Compre<span class="text-cobalt">PDF</span></span>
          </a>
          <nav class="flex items-center gap-1 ml-auto">
            <a routerLink="/" [routerLinkActiveOptions]="{ exact: true }" routerLinkActive="nav-active" class="nav-link">Herramientas</a>
            <a routerLink="/mis-trabajos" routerLinkActive="nav-active" class="nav-link">Mis trabajos</a>
            @if (isAdmin()) {
              <a routerLink="/usuarios" routerLinkActive="nav-active" class="nav-link">Usuarios</a>
              <a routerLink="/certificados" routerLinkActive="nav-active" class="nav-link">Certificados</a>
            }
            <a routerLink="/stats" routerLinkActive="nav-active" class="nav-link">Estadísticas</a>

            @if (user(); as u) {
              <button class="user-btn" [matMenuTriggerFor]="userMenu">
                <span class="avatar">{{ initials(u.nombre || u.username) }}</span>
                <span class="user-name">{{ u.nombre || u.username }}</span>
                <span class="material-icons" style="font-size:18px">expand_more</span>
              </button>
              <mat-menu #userMenu="matMenu">
                <div class="menu-head" mat-menu-item disabled>
                  <div>
                    <div class="font-medium">{{ u.username }}</div>
                    <div class="text-sm text-ink-soft">{{ u.rol === 'admin' ? 'Administrador' : 'Usuario' }}</div>
                  </div>
                </div>
                <button mat-menu-item (click)="goChangePassword()">
                  <span class="material-icons">lock_reset</span>
                  <span>Cambiar contraseña</span>
                </button>
                <button mat-menu-item (click)="logout()">
                  <span class="material-icons">logout</span>
                  <span>Cerrar sesión</span>
                </button>
              </mat-menu>
            }
          </nav>
        </div>
      </header>
    }

    <main [class.container]="showChrome()">
      <router-outlet></router-outlet>
    </main>

    @if (showChrome()) {
      <footer class="border-t border-line py-6 mt-8">
        <div class="container flex flex-col md:flex-row items-center justify-between gap-2 text-sm text-ink-soft">
          <span>ComprePDF — herramienta interna</span>
          <span>Los archivos se procesan en tu red y se eliminan a las 24 horas.</span>
        </div>
      </footer>
    }
  `,
  styles: [`
    main {
      min-height: calc(100vh - 64px - 77px);
    }

    .brand-mark {
      display: inline-block;
      width: 22px;
      height: 26px;
      background: var(--cobalt);
      border-radius: 4px;
      clip-path: polygon(0 0, 68% 0, 100% 26%, 100% 100%, 0 100%);
    }

    @media (max-width: 640px) {
      nav {
        width: 100%;
        justify-content: center;
        margin-top: 0.25rem;
        flex-wrap: wrap;
      }
    }

    .nav-link {
      padding: 0.45rem 0.9rem;
      border-radius: 8px;
      color: var(--ink-soft);
      font-weight: 500;
      font-size: 0.95rem;
      text-decoration: none;
      transition: color 0.15s ease, background 0.15s ease;
    }

    .nav-link:hover {
      color: var(--ink);
      background: var(--mist);
    }

    .nav-active {
      color: var(--cobalt);
      background: var(--cobalt-soft);
    }

    .user-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      margin-left: 0.5rem;
      padding: 0.35rem 0.6rem 0.35rem 0.4rem;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--paper);
      color: var(--ink);
      font-family: inherit;
      font-weight: 500;
      font-size: 0.9rem;
      cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .user-btn:hover { border-color: var(--cobalt); background: var(--mist); }

    .avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: var(--cobalt);
      color: #fff;
      font-size: 0.75rem;
      font-weight: 700;
    }

    .user-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .menu-head { line-height: 1.3; opacity: 1 !important; }
  `]
})
export class AppComponent {
  private currentUrl = signal<string>('');

  user = computed(() => this.auth.user());
  isAdmin = computed(() => this.auth.isAdmin());

  /** Oculta header/footer en /login y /registro (páginas públicas sin sesión). */
  showChrome = computed(() => {
    if (!this.auth.isAuthenticated()) return false;
    const url = this.currentUrl().split('?')[0];
    return url !== '/login' && url !== '/registro';
  });

  constructor(private auth: AuthService, private router: Router) {
    this.currentUrl.set(this.router.url);
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.currentUrl.set(e.urlAfterRedirects));
  }

  initials(name: string): string {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join('');
  }

  goChangePassword(): void {
    this.router.navigate(['/cambiar-contrasena']);
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
