import { Injectable } from '@angular/core';

export interface StoredPhoto {
  id: number;
  createdAt: string;
  bytes: number;
  /** URL para mostrar la imagen (mismo origen). */
  url: string;
  /** URL que fuerza la descarga del archivo. */
  downloadUrl: string;
}

/** La API respondió 401: hace falta iniciar sesión en la galería. */
export class UnauthorizedError extends Error {}

const ensureOk = (response: Response, message: string) => {
  if (response.status === 401) throw new UnauthorizedError(message);
  if (!response.ok) throw new Error(`${message} (${response.status})`);
};

export interface PhotoListing {
  photos: StoredPhoto[];
  totalBytes: number;
}

/**
 * Cliente de la API de fotografías de evidencia. Las fotos se guardan en el
 * servidor (PostgreSQL en Railway), por lo que pueden consultarse y eliminarse
 * desde cualquier navegador en la página /fotos, previa sesión de administrador
 * (cookie HttpOnly que el navegador envía también en <img> y descargas).
 */
@Injectable({ providedIn: 'root' })
export class PhotoStorageService {
  private static readonly API = '/api/photos';
  private static readonly SESSION = '/api/session';

  async login(password: string): Promise<boolean> {
    const response = await fetch(PhotoStorageService.SESSION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (response.status === 401) return false;
    ensureOk(response, 'Error al iniciar sesión');
    return true;
  }

  async logout(): Promise<void> {
    await fetch(PhotoStorageService.SESSION, { method: 'DELETE' });
  }

  async save(dataUrl: string): Promise<void> {
    const response = await fetch(PhotoStorageService.API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    });
    if (!response.ok) throw new Error(`Error al guardar la fotografía (${response.status})`);
  }

  async list(): Promise<PhotoListing> {
    const response = await fetch(PhotoStorageService.API);
    ensureOk(response, 'Error al listar las fotografías');
    const body: { photos: { id: number; createdAt: string; bytes: number }[]; totalBytes: number } =
      await response.json();
    return {
      totalBytes: body.totalBytes,
      photos: body.photos.map((p) => ({
        ...p,
        url: `${PhotoStorageService.API}/${p.id}`,
        downloadUrl: `${PhotoStorageService.API}/${p.id}?download`,
      })),
    };
  }

  async remove(id: number): Promise<void> {
    const response = await fetch(`${PhotoStorageService.API}/${id}`, { method: 'DELETE' });
    ensureOk(response, 'Error al eliminar la fotografía');
  }

  async clear(): Promise<void> {
    const response = await fetch(PhotoStorageService.API, { method: 'DELETE' });
    ensureOk(response, 'Error al eliminar las fotografías');
  }
}
