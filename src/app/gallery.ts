import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { PhotoStorageService, StoredPhoto } from './photo-storage.service';

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

  readonly usedLabel = computed(() => {
    const bytes = this.usedBytes();
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} kB`;
    return `${bytes} B`;
  });

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    this.error.set('');
    try {
      const listing = await this.storage.list();
      this.photos.set(listing.photos);
      this.usedBytes.set(listing.totalBytes);
    } catch (e) {
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
      console.error(e);
      this.error.set('No se pudo completar la eliminación. Intente nuevamente.');
      this.pendingDelete.set(null);
    } finally {
      this.deleting.set(false);
    }
  }
}
