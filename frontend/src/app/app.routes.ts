import { Routes } from '@angular/router';
import { authGuard } from './core/auth.service';

export const routes: Routes = [
  // public: residents check pickup schedules without logging in
  { path: '', loadComponent: () => import('./pages/public-check').then((m) => m.PublicCheck), title: 'Pickup schedule · TrashWatch' },
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.Login), title: 'Log in · TrashWatch' },
  { path: 'stop', loadComponent: () => import('./pages/stop-sms').then((m) => m.StopSms), title: 'Stop SMS · TrashWatch' },
  { path: 'privacy', loadComponent: () => import('./pages/privacy').then((m) => m.Privacy), title: 'Privacy notice · TrashWatch' },
  {
    path: 'admin',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/admin-layout').then((m) => m.AdminLayout),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', loadComponent: () => import('./pages/dashboard').then((m) => m.DashboardPage), title: 'Dashboard · TrashWatch' },
      { path: 'monitor', loadComponent: () => import('./pages/monitor').then((m) => m.Monitor), title: 'Monitor · TrashWatch' },
      { path: 'areas', loadComponent: () => import('./pages/areas').then((m) => m.AreasPage), title: 'Areas · TrashWatch' },
      { path: 'areas/:id', loadComponent: () => import('./pages/area-detail').then((m) => m.AreaDetail), title: 'Area · TrashWatch' },
      { path: 'reports', loadComponent: () => import('./pages/reports').then((m) => m.ReportsPage), title: 'Reports · TrashWatch' },
      { path: 'sms', loadComponent: () => import('./pages/sms-log').then((m) => m.SmsLogPage), title: 'SMS log · TrashWatch' },
    ],
  },
  { path: '**', redirectTo: '' },
];
