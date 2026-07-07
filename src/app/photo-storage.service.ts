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

export interface PhotoListing {
  photos: StoredPhoto[];
  totalBytes: number;
}

/**
 * Cliente de la API de fotografías de evidencia. Las fotos se guardan en el
 * servidor (PostgreSQL en Railway), por lo que pueden consultarse y eliminarse
 * desde cualquier navegador en la página /fotos.
 */
@Injectable({ providedIn: 'root' })
export class PhotoStorageService {
  private static readonly API = '/api/photos';

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
    if (!response.ok) throw new Error(`Error al listar las fotografías (${response.status})`);
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
    if (!response.ok) throw new Error(`Error al eliminar la fotografía (${response.status})`);
  }

  async clear(): Promise<void> {
    const response = await fetch(PhotoStorageService.API, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Error al eliminar las fotografías (${response.status})`);
  }
}
