import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/home/home.component').then(m => m.HomeComponent)
  },
  {
    path: 'compress',
    loadComponent: () => import('./features/compress/compress.component').then(m => m.CompressComponent)
  },
  {
    path: 'tools/:tool',
    loadComponent: () => import('./features/tools/tools.component').then(m => m.ToolsComponent)
  },
  { path: 'tools', redirectTo: '', pathMatch: 'full' },
  {
    path: 'stats',
    loadComponent: () => import('./features/stats/stats.component').then(m => m.StatsComponent)
  },
  {
    path: 'certificados',
    loadComponent: () => import('./features/certificates/certificates.component').then(m => m.CertificatesComponent)
  },
  { path: '**', redirectTo: '' }
];
