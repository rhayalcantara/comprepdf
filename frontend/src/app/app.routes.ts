import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  // Pública: única ruta sin authGuard (junto con el propio login del backend).
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then(m => m.LoginComponent)
  },

  // Pública: autorregistro (sin authGuard, igual que /login). Un usuario no
  // logueado debe poder llegar aquí para crear su cuenta.
  {
    path: 'registro',
    loadComponent: () => import('./features/register/register.component').then(m => m.RegisterComponent)
  },

  // Cambio de contraseña obligatorio: protegida por authGuard, pero el guard la
  // permite aun con mustChangePassword=true (para poder completar el cambio).
  {
    path: 'cambiar-contrasena',
    canActivate: [authGuard],
    loadComponent: () => import('./features/change-password/change-password.component').then(m => m.ChangePasswordComponent)
  },

  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/home/home.component').then(m => m.HomeComponent)
  },
  {
    path: 'compress',
    canActivate: [authGuard],
    loadComponent: () => import('./features/compress/compress.component').then(m => m.CompressComponent)
  },
  {
    path: 'tools/:tool',
    canActivate: [authGuard],
    loadComponent: () => import('./features/tools/tools.component').then(m => m.ToolsComponent)
  },
  { path: 'tools', redirectTo: '', pathMatch: 'full' },
  // El Estudio: un solo espacio de trabajo con las operaciones encadenadas.
  // Las rutas por herramienta siguen vivas (enlaces guardados, manual de usuario).
  {
    path: 'estudio',
    canActivate: [authGuard],
    loadComponent: () => import('./features/estudio/estudio.component').then(m => m.EstudioComponent)
  },
  {
    path: 'editor',
    canActivate: [authGuard],
    loadComponent: () => import('./features/editor/pdf-editor.component').then(m => m.PdfEditorComponent)
  },
  {
    path: 'organizar',
    canActivate: [authGuard],
    loadComponent: () => import('./features/organize/pdf-organize.component').then(m => m.PdfOrganizeComponent)
  },
  {
    path: 'formularios',
    canActivate: [authGuard],
    loadComponent: () => import('./features/forms/form-list.component').then(m => m.FormListComponent)
  },
  {
    path: 'formularios/nuevo',
    canActivate: [authGuard],
    loadComponent: () => import('./features/forms/form-editor.component').then(m => m.FormEditorComponent)
  },
  {
    path: 'formularios/:id/editar',
    canActivate: [authGuard],
    loadComponent: () => import('./features/forms/form-editor.component').then(m => m.FormEditorComponent)
  },
  {
    path: 'mis-trabajos',
    canActivate: [authGuard],
    loadComponent: () => import('./features/jobs/jobs.component').then(m => m.JobsComponent)
  },
  {
    path: 'stats',
    canActivate: [authGuard],
    loadComponent: () => import('./features/stats/stats.component').then(m => m.StatsComponent)
  },
  {
    path: 'usuarios',
    canActivate: [adminGuard],
    loadComponent: () => import('./features/users/users.component').then(m => m.UsersComponent)
  },
  {
    path: 'certificados',
    canActivate: [adminGuard],
    loadComponent: () => import('./features/certificates/certificates.component').then(m => m.CertificatesComponent)
  },
  { path: '**', redirectTo: '' }
];
