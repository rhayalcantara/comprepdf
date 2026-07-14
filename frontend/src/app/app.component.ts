import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="border-b border-line bg-white sticky top-0 z-50">
      <div class="container flex flex-wrap items-center gap-x-6 py-3">
        <a routerLink="/" class="flex items-center gap-2 no-underline">
          <!-- Marca: una hoja con esquina doblada, la misma firma de las cards -->
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="font-display font-bold text-xl text-ink">Compre<span class="text-cobalt">PDF</span></span>
        </a>
        <nav class="flex items-center gap-1 ml-auto">
          <a routerLink="/" [routerLinkActiveOptions]="{ exact: true }" routerLinkActive="nav-active" class="nav-link">Herramientas</a>
          <a routerLink="/compress" routerLinkActive="nav-active" class="nav-link">Comprimir</a>
          <a routerLink="/certificados" routerLinkActive="nav-active" class="nav-link">Certificados</a>
          <a routerLink="/stats" routerLinkActive="nav-active" class="nav-link">Estadísticas</a>
        </nav>
      </div>
    </header>

    <main class="container">
      <router-outlet></router-outlet>
    </main>

    <footer class="border-t border-line py-6 mt-8">
      <div class="container flex flex-col md:flex-row items-center justify-between gap-2 text-sm text-ink-soft">
        <span>ComprePDF — herramienta interna</span>
        <span>Los archivos se procesan en tu red y se eliminan a las 24 horas.</span>
      </div>
    </footer>
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

    @media (max-width: 480px) {
      nav {
        width: 100%;
        justify-content: center;
        margin-top: 0.25rem;
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
  `]
})
export class AppComponent {
  title = 'ComprePDF';
}
