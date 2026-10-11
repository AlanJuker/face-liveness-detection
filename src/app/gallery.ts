import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { PhotoStorageService, StoredPhoto, UnauthorizedError } from './photo-storage.service';

type PendingDelete = { kind: 'one'; photo: StoredPhoto } | { kind: 'all' };

@Component({
  selector: 'app-gallery',
  imports: [DatePipe],
  templateUrl: './gallery.html',
  styleUrl: './gallery.css',
})
export class Gallery implements OnInit {
  private readonly storage = inject(PhotoStorageService);

  readonly photos = signal<StoredPhoto[]>([]);
  readonly usedBytes = signal(0);
  readonly loading = signal(true);
  readonly error = signal('');
  /** Confirmación pendiente de borrado (una foto o todas). */
  readonly pendingDelete = signal<PendingDelete | null>(null);
  /** Ids con eliminación en curso, para deshabilitar sus botones. */
  readonly deleting = signal(false);
  /** La API exige sesión: se muestra el formulario de contraseña. */
  readonly needsLogin = signal(false);
  readonly loginError = signal('');
  readonly loggingIn = signal(false);

  readonly usedLabel = computed(() => {
    const bytes = this.usedBytes();
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} kB`;
    return `${bytes} B`;
  });

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async login(password: string): Promise<void> {
    if (!password || this.loggingIn()) return;
    this.loggingIn.set(true);
    this.loginError.set('');
    try {
      if (await this.storage.login(password)) {
        this.needsLogin.set(false);
        this.loading.set(true);
        await this.refresh();
      } else {
        this.loginError.set('Contraseña incorrecta.');
      }
    } catch (e) {
      console.error(e);
      this.loginError.set('No se pudo iniciar sesión. Intente nuevamente.');
    } finally {
      this.loggingIn.set(false);
    }
  }

  async logout(): Promise<void> {
    await this.storage.logout();
    this.photos.set([]);
    this.usedBytes.set(0);
    this.needsLogin.set(true);
  }

  private async refresh(): Promise<void> {
    this.error.set('');
    try {
      const listing = await this.storage.list();
      this.photos.set(listing.photos);
      this.usedBytes.set(listing.totalBytes);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        this.needsLogin.set(true);
        return;
      }
      console.error(e);
      this.error.set('No se pudieron cargar las fotografías. Intente nuevamente.');
    } finally {
      this.loading.set(false);
    }
  }

  askRemove(photo: StoredPhoto): void {
    this.pendingDelete.set({ kind: 'one', photo });
  }

  askRemoveAll(): void {
    this.pendingDelete.set({ kind: 'all' });
  }

  cancelDelete(): void {
    this.pendingDelete.set(null);
  }

  async confirmDelete(): Promise<void> {
    const pending = this.pendingDelete();
    if (!pending || this.deleting()) return;
    this.deleting.set(true);
    try {
      if (pending.kind === 'one') {
        await this.storage.remove(pending.photo.id);
      } else {
        await this.storage.clear();
      }
      this.pendingDelete.set(null);
      await this.refresh();
    } catch (e) {
      this.pendingDelete.set(null);
      if (e instanceof UnauthorizedError) {
        this.needsLogin.set(true);
        return;
      }
      console.error(e);
      this.error.set('No se pudo completar la eliminación. Intente nuevamente.');
    } finally {
      this.deleting.set(false);
    }
  }
}
