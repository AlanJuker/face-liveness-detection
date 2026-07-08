import { Routes } from '@angular/router';
import { Verification } from './verification';
import { Gallery } from './gallery';

export const routes: Routes = [
  { path: '', component: Verification, title: 'Prueba de vida — Cambio de Domicilio' },
  { path: 'fotos', component: Gallery, title: 'Fotografías — Cambio de Domicilio' },
  { path: '**', redirectTo: '' },
];
