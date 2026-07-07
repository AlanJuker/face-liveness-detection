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
    try {
      const photos = await this.storage.list();
      this.photos.set(photos.sort((a, b) => b.id - a.id));
      this.usedBytes.set(await this.storage.usedBytes());
    } catch (e) {
      console.error(e);
    } finally {
      this.loading.set(false);
    }
  }

  download(photo: StoredPhoto): void {
    const link = document.createElement('a');
    link.href = photo.dataUrl;
    link.download = `verificacion-rostro-${photo.createdAt.slice(0, 19).replace(/[T:]/g, '-')}.jpg`;
    link.click();
  }

  async remove(photo: StoredPhoto): Promise<void> {
    await this.storage.remove(photo.id);
    await this.refresh();
  }

  async removeAll(): Promise<void> {
    if (!confirm('¿Eliminar todas las fotografías almacenadas? Esta acción no se puede deshacer.')) {
      return;
    }
    await this.storage.clear();
    await this.refresh();
  }
}
