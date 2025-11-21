import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: '/compress', pathMatch: 'full' },
  {
    path: 'compress',
    loadComponent: () => import('./features/compress/compress.component').then(m => m.CompressComponent)
  },
  {
    path: 'stats',
    loadComponent: () => import('./features/stats/stats.component').then(m => m.StatsComponent)
  }
];
