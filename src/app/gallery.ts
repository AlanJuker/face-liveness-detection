import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { PhotoStorageService, StoredPhoto } from './photo-storage.service';

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

  async remove(photo: StoredPhoto): Promise<void> {
    try {
      await this.storage.remove(photo.id);
      await this.refresh();
    } catch (e) {
      console.error(e);
      this.error.set('No se pudo eliminar la fotografía.');
    }
  }

  async removeAll(): Promise<void> {
    if (!confirm('¿Eliminar todas las fotografías almacenadas? Esta acción no se puede deshacer.')) {
      return;
    }
    try {
      await this.storage.clear();
      await this.refresh();
    } catch (e) {
      console.error(e);
      this.error.set('No se pudieron eliminar las fotografías.');
    }
  }
}
