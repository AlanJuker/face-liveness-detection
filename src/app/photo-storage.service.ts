import { Injectable } from '@angular/core';

export interface StoredPhoto {
  id: number;
  dataUrl: string;
  createdAt: string;
}

/**
 * Almacena las fotografías de evidencia en IndexedDB (base de datos local del
 * navegador). Los datos nunca salen del dispositivo; la página /fotos permite
 * descargarlas o eliminarlas para liberar espacio.
 */
@Injectable({ providedIn: 'root' })
export class PhotoStorageService {
  private static readonly DB_NAME = 'liveness-photos';
  private static readonly STORE = 'photos';

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(PhotoStorageService.DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PhotoStorageService.STORE)) {
          request.result.createObjectStore(PhotoStorageService.STORE, {
            keyPath: 'id',
            autoIncrement: true,
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async run<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = action(db.transaction(PhotoStorageService.STORE, mode).objectStore(PhotoStorageService.STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  save(dataUrl: string): Promise<number> {
    return this.run('readwrite', (store) =>
      store.add({ dataUrl, createdAt: new Date().toISOString() }),
    );
  }

  list(): Promise<StoredPhoto[]> {
    return this.run('readonly', (store) => store.getAll());
  }

  remove(id: number): Promise<void> {
    return this.run('readwrite', (store) => store.delete(id));
  }

  clear(): Promise<void> {
    return this.run('readwrite', (store) => store.clear());
  }

  /** Espacio ocupado por el origen (aproximado), en bytes. */
  async usedBytes(): Promise<number> {
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      return estimate.usage ?? 0;
    }
    return 0;
  }
}
