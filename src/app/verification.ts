import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FaceRecognitionService, LiveFrame } from './face-recognition.service';
import { PhotoStorageService } from './photo-storage.service';

type Phase = 'loading' | 'camera-error' | 'idle' | 'testing' | 'success' | 'failed';

interface Challenge {
  id: 'blink' | 'smile' | 'turn';
  title: string;
  instruction: string;
  done: boolean;
}

@Component({
  selector: 'app-verification',
  imports: [],
  templateUrl: './verification.html',
  styleUrl: './verification.css',
})
export class Verification implements OnInit, OnDestroy {
  private readonly faceService = inject(FaceRecognitionService);
  private readonly photoStorage = inject(PhotoStorageService);
  private readonly videoRef = viewChild.required<ElementRef<HTMLVideoElement>>('video');

  readonly phase = signal<Phase>('loading');
  readonly faceDetected = signal(false);
  readonly challenges = signal<Challenge[]>([]);
  readonly currentIndex = signal(0);
  readonly secondsLeft = signal(0);
  readonly failReason = signal('');
  /** Retroalimentación en vivo durante el reto actual (p. ej. "abra los ojos"). */
  readonly liveFeedback = signal('');

  /** Modo diagnóstico (abrir la app con ?debug): muestra las métricas en vivo. */
  readonly debugMode = new URLSearchParams(window.location.search).has('debug');
  readonly debugInfo = signal('');

  /** Ventana previa con recomendaciones (retirar accesorios, iluminación…). */
  readonly showPrep = signal(false);
  /** Lámina visible del carrusel de indicaciones. */
  readonly prepSlide = signal(0);
  static readonly PREP_SLIDES = 4;
  readonly prepSlides = Array.from({ length: Verification.PREP_SLIDES }, (_, i) => i);

  /** Fotografía del rostro capturada al aprobar la verificación (data URL JPEG). */
  readonly capturedPhoto = signal<string | null>(null);

  /** Última posición conocida del rostro, para recortar la fotografía. */
  private lastBox: { x: number; y: number; width: number; height: number } | null = null;

  readonly current = computed<Challenge | null>(
    () => this.challenges()[this.currentIndex()] ?? null,
  );
  readonly progress = computed(() => {
    const list = this.challenges();
    if (list.length === 0) return 0;
    return Math.round((list.filter((c) => c.done).length / list.length) * 100);
  });

  private stream: MediaStream | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  // --- Estado del reto de parpadeo (umbral adaptado a cada cámara/usuario) ---
  /** Mayor apertura ocular observada durante el reto: sirve de referencia. */
  private baselineEyeOpenness = 0;
  private consecutiveClosedFrames = 0;
  private eyesClosedConfirmed = false;

  private challengeDeadline = 0;

  private static readonly CHALLENGE_SECONDS = 20;
  /**
   * Ojos cerrados si la apertura cae por debajo del 88 % de la referencia.
   * A distancia media la caída medida al cerrar los ojos es pequeña
   * (p. ej. de 0.32 a 0.26, ratio ≈ 0.84), por eso el umbral es alto; una
   * imagen estática mantiene el ratio ≈ 1.0 y nunca lo cruza.
   */
  private static readonly CLOSED_RATIO = 0.88;
  /** Ojo cerrado en términos absolutos (EAR típico cerrado ≈ 0.15–0.26). */
  private static readonly CLOSED_ABSOLUTE = 0.25;
  /** Cierre profundo e inequívoco: cuenta con un solo fotograma. */
  private static readonly CLOSED_DEEP_RATIO = 0.78;
  private static readonly CLOSED_DEEP_ABSOLUTE = 0.21;
  /** Ojos abiertos de nuevo al superar el 94 % de la referencia. */
  private static readonly REOPEN_RATIO = 0.94;
  private static readonly REOPEN_ABSOLUTE = 0.3;
  private static readonly CLOSED_FRAMES_REQUIRED = 2;
  private static readonly SMILE_MIN = 0.65;
  private static readonly YAW_MIN = 0.32;

  async ngOnInit(): Promise<void> {
    try {
      await this.faceService.loadModels();
    } catch (e) {
      this.phase.set('camera-error');
      this.failReason.set('No fue posible cargar los componentes de verificación.');
      console.error(e);
      return;
    }
    await this.startCamera();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  private async startCamera(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      const video = this.videoRef().nativeElement;
      video.srcObject = this.stream;
      await video.play();
      this.phase.set('idle');
      this.loop();
    } catch (e) {
      this.phase.set('camera-error');
      this.failReason.set(
        'No fue posible acceder a la cámara. Otorgue el permiso correspondiente y recargue la página.',
      );
      console.error(e);
    }
  }

  openPrep(): void {
    this.prepSlide.set(0);
    this.showPrep.set(true);
  }

  cancelPrep(): void {
    this.showPrep.set(false);
  }

  nextSlide(): void {
    if (this.prepSlide() < Verification.PREP_SLIDES - 1) {
      this.prepSlide.update((i) => i + 1);
    } else {
      this.confirmStart();
    }
  }

  prevSlide(): void {
    this.prepSlide.update((i) => Math.max(0, i - 1));
  }

  confirmStart(): void {
    this.showPrep.set(false);
    this.startTest();
  }

  startTest(): void {
    // Orden aleatorio: impide superar la prueba con un video pregrabado.
    const pool: Challenge[] = [
      {
        id: 'blink',
        title: 'Parpadeo',
        instruction: 'Cierre ambos ojos, manténgalos cerrados un segundo y vuelva a abrirlos.',
        done: false,
      },
      {
        id: 'smile',
        title: 'Sonrisa',
        instruction: 'Sonría de forma visible mirando a la cámara.',
        done: false,
      },
      {
        id: 'turn',
        title: 'Giro de cabeza',
        instruction: 'Gire lentamente la cabeza hacia su izquierda o su derecha.',
        done: false,
      },
    ];
    this.challenges.set(pool.sort(() => Math.random() - 0.5));
    this.currentIndex.set(0);
    this.failReason.set('');
    this.resetChallengeState();
    this.phase.set('testing');
  }

  reset(): void {
    this.phase.set('idle');
    this.challenges.set([]);
    this.failReason.set('');
    this.liveFeedback.set('');
    this.capturedPhoto.set(null);
  }

  downloadPhoto(): void {
    const photo = this.capturedPhoto();
    if (!photo) return;
    const link = document.createElement('a');
    link.href = photo;
    link.download = `verificacion-rostro-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.jpg`;
    link.click();
  }

  private resetChallengeState(): void {
    this.baselineEyeOpenness = 0;
    this.consecutiveClosedFrames = 0;
    this.eyesClosedConfirmed = false;
    this.liveFeedback.set('');
    this.challengeDeadline = Date.now() + Verification.CHALLENGE_SECONDS * 1000;
    this.secondsLeft.set(Verification.CHALLENGE_SECONDS);
  }

  /** Bucle principal de análisis (~8 fotogramas por segundo). */
  private async loop(): Promise<void> {
    if (this.destroyed) return;

    const video = this.videoRef().nativeElement;
    if (video.readyState >= 2) {
      let frame: LiveFrame | null = null;
      try {
        frame = await this.faceService.analyzeFrame(video);
      } catch (e) {
        console.error(e);
      }
      this.faceDetected.set(!!frame);
      if (frame) this.lastBox = frame.box;

      if (this.debugMode) {
        this.debugInfo.set(
          frame
            ? `ojos (EAR): ${frame.eyeOpenness.toFixed(3)} · referencia: ${this.baselineEyeOpenness.toFixed(3)} · ` +
                `ratio: ${(this.baselineEyeOpenness ? frame.eyeOpenness / this.baselineEyeOpenness : 0).toFixed(2)} · ` +
                `sonrisa: ${frame.smile.toFixed(2)} · giro: ${frame.yaw.toFixed(2)}`
            : 'sin rostro',
        );
      }

      if (this.phase() === 'testing') {
        this.secondsLeft.set(Math.max(0, Math.ceil((this.challengeDeadline - Date.now()) / 1000)));
        if (Date.now() > this.challengeDeadline) {
          this.phase.set('failed');
          this.failReason.set(
            'El tiempo asignado se agotó sin completar la indicación. Una fotografía o imagen estática no puede realizar estos movimientos.',
          );
        } else if (frame) {
          this.evaluate(frame);
        }
      }
    }

    this.loopTimer = setTimeout(() => this.loop(), 120);
  }

  private evaluate(frame: LiveFrame): void {
    const challenge = this.current();
    if (!challenge) return;

    let passed = false;
    switch (challenge.id) {
      case 'blink':
        passed = this.evaluateBlink(frame);
        break;
      case 'smile':
        passed = frame.smile > Verification.SMILE_MIN;
        break;
      case 'turn':
        passed = Math.abs(frame.yaw) > Verification.YAW_MIN;
        break;
    }

    if (!passed) return;

    // La fotografía de evidencia se toma en el instante en que se detecta la
    // sonrisa, para que la persona salga sonriendo.
    if (challenge.id === 'smile') {
      const photo = this.faceService.captureFace(this.videoRef().nativeElement, frame.box);
      this.capturedPhoto.set(photo);
      this.photoStorage.save(photo).catch((e) => console.error('No se pudo guardar la foto', e));
    }

    this.challenges.update((list) =>
      list.map((c, i) => (i === this.currentIndex() ? { ...c, done: true } : c)),
    );

    if (this.currentIndex() + 1 >= this.challenges().length) {
      // Respaldo: si por alguna razón no hay fotografía, se toma una al aprobar.
      if (!this.capturedPhoto()) {
        const photo = this.faceService.captureFace(
          this.videoRef().nativeElement,
          this.lastBox ?? undefined,
        );
        this.capturedPhoto.set(photo);
        this.photoStorage.save(photo).catch((e) => console.error('No se pudo guardar la foto', e));
      }
      this.phase.set('success');
      this.liveFeedback.set('');
    } else {
      this.currentIndex.update((i) => i + 1);
      this.resetChallengeState();
    }
  }

  /**
   * Combina un umbral absoluto (valores típicos de ojo cerrado) con uno
   * relativo a la mayor apertura observada en este reto, para adaptarse a
   * cada cámara y persona. Un cierre profundo cuenta con un solo fotograma,
   * por si la cámara entrega pocos fotogramas por segundo.
   */
  private evaluateBlink(frame: LiveFrame): boolean {
    this.baselineEyeOpenness = Math.max(this.baselineEyeOpenness, frame.eyeOpenness);
    if (this.baselineEyeOpenness === 0) return false;

    const ear = frame.eyeOpenness;
    const ratio = ear / this.baselineEyeOpenness;

    if (!this.eyesClosedConfirmed) {
      const closed = ear < Verification.CLOSED_ABSOLUTE || ratio < Verification.CLOSED_RATIO;
      if (closed) {
        this.consecutiveClosedFrames++;
        const deepClose = ear < Verification.CLOSED_DEEP_ABSOLUTE || ratio < Verification.CLOSED_DEEP_RATIO;
        if (deepClose || this.consecutiveClosedFrames >= Verification.CLOSED_FRAMES_REQUIRED) {
          this.eyesClosedConfirmed = true;
          this.liveFeedback.set('Ojos cerrados detectados. Ahora abra los ojos.');
        }
      } else {
        this.consecutiveClosedFrames = 0;
      }
      return false;
    }

    return ear > Verification.REOPEN_ABSOLUTE || ratio > Verification.REOPEN_RATIO;
  }
}
