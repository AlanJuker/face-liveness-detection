import { Routes } from '@angular/router';
import { Verification } from './verification';
import { Gallery } from './gallery';

export const routes: Routes = [
  { path: '', component: Verification },
  { path: 'fotos', component: Gallery },
  { path: '**', redirectTo: '' },
];
