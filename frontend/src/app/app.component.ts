import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatToolbarModule, MatButtonModule, MatIconModule],
  template: `
    <mat-toolbar color="primary">
      <span class="font-bold text-xl">ComprePDF</span>
      <span class="flex-1"></span>
      <button mat-button routerLink="/compress" routerLinkActive="active-link">
        <mat-icon>compress</mat-icon>
        Comprimir
      </button>
      <button mat-button routerLink="/stats" routerLinkActive="active-link">
        <mat-icon>analytics</mat-icon>
        Estadísticas
      </button>
    </mat-toolbar>
    <main class="container py-8">
      <router-outlet></router-outlet>
    </main>
  `,
  styles: [`
    main {
      min-height: calc(100vh - 64px);
      background-color: #f5f5f5;
    }

    .active-link {
      background-color: rgba(255, 255, 255, 0.2);
    }

    .flex-1 {
      flex: 1;
    }
  `]
})
export class AppComponent {
  title = 'ComprePDF';
}
