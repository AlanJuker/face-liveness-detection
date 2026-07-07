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

/**
 * Flujo: intro (sin cámara) → popup de instrucciones → positioning (cámara
 * encendida, centrar el rostro) → testing (gestos) → success | failed.
 */
type Phase = 'intro' | 'camera-error' | 'positioning' | 'testing' | 'success' | 'failed';

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

  readonly phase = signal<Phase>('intro');
  readonly modelsReady = signal(false);
  readonly faceDetected = signal(false);
  readonly multipleFaces = signal(false);
  readonly faceInOval = signal(false);
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

  /** El rostro está correctamente encuadrado y es el único en escena. */
  readonly faceOk = computed(
    () => this.faceDetected() && !this.multipleFaces() && this.faceInOval(),
  );
  /** Hay un problema de encuadre que se marca en rojo. */
  readonly faceBad = computed(
    () => this.faceDetected() && (this.multipleFaces() || !this.faceInOval()),
  );

  readonly current = computed<Challenge | null>(
    () => this.challenges()[this.currentIndex()] ?? null,
  );
  readonly progress = computed(() => {
    const list = this.challenges();
    if (list.length === 0) return 0;
    return Math.round((list.filter((c) => c.done).length / list.length) * 100);
  });

  /** Mensaje de guía de encuadre (positioning y testing). */
  readonly framingHint = computed(() => {
    if (!this.faceDetected()) return 'No se detecta su rostro. Colóquese frente a la cámara.';
    if (this.multipleFaces()) return 'Solo debe haber una persona frente a la cámara.';
    if (!this.faceInOval()) return 'Centre su rostro dentro del óvalo.';
    return '';
  });

  /** Última posición conocida del rostro, para recortar la fotografía. */
  private lastBox: { x: number; y: number; width: number; height: number } | null = null;

  private stream: MediaStream | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  // --- Estado del reto de parpadeo (umbral adaptado a cada cámara/usuario) ---
  /** Mayor apertura ocular observada durante el reto: sirve de referencia. */
  private baselineEyeOpenness = 0;
  private consecutiveClosedFrames = 0;
  private eyesClosedConfirmed = false;

  private challengeDeadline = 0;
  /** Pausa entre retos para que un gesto no contamine el siguiente. */
  private settleUntil = 0;
  /** Fotogramas seguidos con encuadre correcto antes de iniciar los retos. */
  private stableFrames = 0;

  // --- Estado anti-suplantación (los gestos deben ser TRANSICIONES) ---
  /** Fotograma anterior, para medir el movimiento de la cabeza/imagen. */
  private prevFrame: LiveFrame | null = null;
  /** Sonrisa: primero debe verse un gesto serio (una foto sonriente no puede). */
  private neutralFrames = 0;
  private neutralSeen = false;
  /** Giro: primero de frente, luego girar y regresar al centro. */
  private frontalFrames = 0;
  private frontalSeen = false;
  private turnedSeen = false;
  /** Continuidad: si el rostro desaparece demasiado tiempo, la prueba falla. */
  private faceAbsentSince = 0;

  private static readonly CHALLENGE_SECONDS = 20;
  private static readonly SETTLE_MS = 1500;
  private static readonly STABLE_FRAMES_REQUIRED = 6;
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
  /** Antes de sonreír debe verse un gesto claramente serio. */
  private static readonly NEUTRAL_MAX = 0.3;
  private static readonly YAW_MIN = 0.32;
  /** Movimiento máximo entre fotogramas para considerar la cabeza quieta
   * (mover o inclinar un teléfono con una foto desplaza toda la imagen).
   * Tolerante al micro-movimiento natural y al jitter del detector. */
  private static readonly STILL_CENTER_DELTA = 0.05;
  private static readonly STILL_WIDTH_DELTA = 0.05;
  private static readonly STILL_YAW_DELTA = 0.14;
  /** Para completar el giro basta volver aproximadamente al centro. */
  private static readonly RETURN_YAW_MAX = 0.22;
  /** Si el rostro desaparece más de este tiempo durante la prueba, falla. */
  private static readonly ABSENCE_LIMIT_MS = 3000;
  /** El parpadeo solo se evalúa con la cabeza de frente (evita falsos
   * positivos: al girar la cabeza los landmarks de los ojos se estrechan). */
  private static readonly FRONTAL_YAW_MAX = 0.18;
  /** Óvalo guía (coordenadas relativas al video, igual que en el CSS). */
  private static readonly OVAL = { cx: 0.5, cy: 0.5, rx: 0.28, ry: 0.42 };

  async ngOnInit(): Promise<void> {
    try {
      await this.faceService.loadModels();
      this.modelsReady.set(true);
    } catch (e) {
      this.phase.set('camera-error');
      this.failReason.set('No fue posible cargar los componentes de verificación.');
      console.error(e);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.stopCamera();
  }

  // ---- flujo: popup → cámara → posicionamiento → retos ----

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

  async confirmStart(): Promise<void> {
    this.showPrep.set(false);
    await this.startCamera();
  }

  private async startCamera(): Promise<void> {
    if (this.stream) {
      this.beginPositioning();
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      const video = this.videoRef().nativeElement;
      video.srcObject = this.stream;
      await video.play();
      this.beginPositioning();
      this.loop();
    } catch (e) {
      this.phase.set('camera-error');
      this.failReason.set(
        'No fue posible acceder a la cámara. Otorgue el permiso correspondiente y recargue la página.',
      );
      console.error(e);
    }
  }

  private stopCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private beginPositioning(): void {
    this.stableFrames = 0;
    this.capturedPhoto.set(null);
    this.failReason.set('');
    this.liveFeedback.set('');
    this.phase.set('positioning');
  }

  private startTest(): void {
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
        instruction: 'Mire de frente con gesto serio y, cuando se le indique, sonría ampliamente.',
        done: false,
      },
      {
        id: 'turn',
        title: 'Giro de cabeza',
        instruction:
          'Mire de frente, gire lentamente la cabeza hacia un lado y regrese al centro.',
        done: false,
      },
    ];
    this.challenges.set(pool.sort(() => Math.random() - 0.5));
    this.currentIndex.set(0);
    this.resetChallengeState();
    this.phase.set('testing');
  }

  /** Volver a intentar: la cámara sigue encendida, regresa al encuadre. */
  retry(): void {
    this.beginPositioning();
  }

  /** Terminar: apaga la cámara y vuelve a la pantalla inicial. */
  finish(): void {
    this.stopCamera();
    this.challenges.set([]);
    this.phase.set('intro');
  }

  private resetChallengeState(): void {
    this.baselineEyeOpenness = 0;
    this.consecutiveClosedFrames = 0;
    this.eyesClosedConfirmed = false;
    this.neutralFrames = 0;
    this.neutralSeen = false;
    this.frontalFrames = 0;
    this.frontalSeen = false;
    this.turnedSeen = false;
    this.faceAbsentSince = 0;
    this.liveFeedback.set('');
    this.challengeDeadline = Date.now() + Verification.CHALLENGE_SECONDS * 1000;
    this.secondsLeft.set(Verification.CHALLENGE_SECONDS);
  }

  /**
   * La cabeza está quieta si el rostro apenas se movió respecto al fotograma
   * anterior. Mover, acercar o inclinar un teléfono con una foto desplaza y
   * escala toda la imagen a la vez, lo que rompe esta condición.
   */
  private isStill(frame: LiveFrame): boolean {
    const prev = this.prevFrame;
    if (!prev) return false;
    const dcx = Math.abs(frame.box.x + frame.box.width / 2 - (prev.box.x + prev.box.width / 2));
    const dcy = Math.abs(frame.box.y + frame.box.height / 2 - (prev.box.y + prev.box.height / 2));
    const dw = Math.abs(frame.box.width - prev.box.width);
    const dyaw = Math.abs(frame.yaw - prev.yaw);
    return (
      dcx < Verification.STILL_CENTER_DELTA &&
      dcy < Verification.STILL_CENTER_DELTA &&
      dw < Verification.STILL_WIDTH_DELTA &&
      dyaw < Verification.STILL_YAW_DELTA
    );
  }

  // ---- bucle principal de análisis (~8 fotogramas por segundo) ----

  private async loop(): Promise<void> {
    if (this.destroyed || !this.stream) return;

    const video = this.videoRef().nativeElement;
    if (video.readyState >= 2) {
      let faces = 0;
      let frame: LiveFrame | null = null;
      try {
        ({ faces, frame } = await this.faceService.analyzeFrame(video));
      } catch (e) {
        console.error(e);
      }
      this.faceDetected.set(faces > 0);
      this.multipleFaces.set(faces > 1);
      this.faceInOval.set(frame ? this.isInsideOval(frame.box) : false);
      if (frame) this.lastBox = frame.box;

      if (this.debugMode) {
        this.debugInfo.set(
          frame
            ? `caras: ${faces} · ojos (EAR): ${frame.eyeOpenness.toFixed(3)} · referencia: ${this.baselineEyeOpenness.toFixed(3)} · ` +
                `ratio: ${(this.baselineEyeOpenness ? frame.eyeOpenness / this.baselineEyeOpenness : 0).toFixed(2)} · ` +
                `sonrisa: ${frame.smile.toFixed(2)} · giro: ${frame.yaw.toFixed(2)} · en óvalo: ${this.faceInOval()}`
            : 'sin rostro',
        );
      }

      if (this.phase() === 'positioning') {
        this.stableFrames = this.faceOk() ? this.stableFrames + 1 : 0;
        if (this.stableFrames >= Verification.STABLE_FRAMES_REQUIRED) {
          this.startTest();
        }
      } else if (this.phase() === 'testing') {
        this.tickTesting(frame);
      }
    }

    this.loopTimer = setTimeout(() => this.loop(), 120);
  }

  private tickTesting(frame: LiveFrame | null): void {
    const now = Date.now();

    // Continuidad: si el rostro desaparece demasiado tiempo (p. ej. para
    // cambiar la imagen de un teléfono), la prueba falla por completo.
    if (!frame) {
      if (this.faceAbsentSince === 0) this.faceAbsentSince = now;
      if (now - this.faceAbsentSince > Verification.ABSENCE_LIMIT_MS) {
        this.phase.set('failed');
        this.failReason.set(
          'Se perdió la continuidad del rostro durante la prueba. Manténgase frente a la cámara todo el tiempo.',
        );
        return;
      }
    } else {
      this.faceAbsentSince = 0;
    }

    // Pausa de asentamiento entre retos: no se evalúa ni corre el tiempo.
    if (now < this.settleUntil) {
      this.challengeDeadline = now + Verification.CHALLENGE_SECONDS * 1000;
      this.prevFrame = frame ?? this.prevFrame;
      return;
    }

    // Encuadre incorrecto (sin cara, varias caras o fuera del óvalo):
    // se pausa la evaluación y el temporizador no avanza en su contra.
    if (!frame || !this.faceOk()) {
      this.challengeDeadline += 120;
      this.prevFrame = frame ?? this.prevFrame;
      return;
    }

    this.secondsLeft.set(Math.max(0, Math.ceil((this.challengeDeadline - now) / 1000)));
    if (now > this.challengeDeadline) {
      this.phase.set('failed');
      this.failReason.set(
        'El tiempo asignado se agotó sin completar la indicación. Una fotografía o imagen estática no puede realizar estos movimientos.',
      );
      return;
    }

    this.evaluate(frame);
    this.prevFrame = frame;
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
        passed = this.evaluateSmile(frame);
        break;
      case 'turn':
        passed = this.evaluateTurn(frame);
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
      // Pausa entre retos: el gesto anterior (p. ej. el giro) no debe
      // contaminar la evaluación del siguiente (p. ej. el parpadeo).
      this.settleUntil = Date.now() + Verification.SETTLE_MS;
      this.liveFeedback.set('Correcto. Vuelva a mirar de frente…');
    }
  }

  /**
   * Combina un umbral absoluto (valores típicos de ojo cerrado) con uno
   * relativo a la mayor apertura observada en este reto, para adaptarse a
   * cada cámara y persona. Un cierre profundo cuenta con un solo fotograma,
   * por si la cámara entrega pocos fotogramas por segundo.
   * Solo se evalúa con la cabeza de frente: al girar la cabeza los landmarks
   * de los ojos se estrechan y producirían un falso parpadeo.
   */
  private evaluateBlink(frame: LiveFrame): boolean {
    if (Math.abs(frame.yaw) > Verification.FRONTAL_YAW_MAX) {
      this.consecutiveClosedFrames = 0;
      this.eyesClosedConfirmed = false;
      if (!this.liveFeedback()) this.liveFeedback.set('Mire de frente a la cámara para continuar.');
      return false;
    }
    // La cabeza (y la cámara) deben estar quietas mientras se detecta el
    // cierre de ojos: inclinar o mover un teléfono con una foto desplaza toda
    // la imagen y simula un parpadeo. Una vez confirmado el cierre, el
    // movimiento leve al reabrir no penaliza.
    if (!this.eyesClosedConfirmed && !this.isStill(frame)) {
      this.consecutiveClosedFrames = 0;
      if (!this.liveFeedback()) {
        this.liveFeedback.set('Mantenga la cabeza quieta y parpadee.');
      }
      return false;
    }
    if (
      this.liveFeedback() === 'Mire de frente a la cámara para continuar.' ||
      this.liveFeedback() === 'Mantenga la cabeza quieta y parpadee.'
    ) {
      this.liveFeedback.set('');
    }

    this.baselineEyeOpenness = Math.max(this.baselineEyeOpenness, frame.eyeOpenness);
    if (this.baselineEyeOpenness === 0) return false;

    const ear = frame.eyeOpenness;
    const ratio = ear / this.baselineEyeOpenness;

    if (!this.eyesClosedConfirmed) {
      const closed = ear < Verification.CLOSED_ABSOLUTE || ratio < Verification.CLOSED_RATIO;
      if (closed) {
        this.consecutiveClosedFrames++;
        const deepClose =
          ear < Verification.CLOSED_DEEP_ABSOLUTE || ratio < Verification.CLOSED_DEEP_RATIO;
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

  /**
   * La sonrisa debe ser una TRANSICIÓN: primero un gesto serio sostenido y
   * después la sonrisa. Una fotografía sonriente nunca muestra el gesto serio
   * y una fotografía seria nunca sonríe: ninguna de las dos puede pasar.
   */
  private evaluateSmile(frame: LiveFrame): boolean {
    const frontal = Math.abs(frame.yaw) < Verification.FRONTAL_YAW_MAX;

    if (!this.neutralSeen) {
      if (frontal && frame.smile < Verification.NEUTRAL_MAX) {
        this.neutralFrames++;
        if (this.neutralFrames >= 2) {
          this.neutralSeen = true;
          this.liveFeedback.set('Perfecto. Ahora sonría ampliamente.');
        }
      } else {
        this.neutralFrames = 0;
        if (!this.liveFeedback()) {
          this.liveFeedback.set('Primero mire de frente con gesto serio, sin sonreír.');
        }
      }
      return false;
    }

    return frame.smile > Verification.SMILE_MIN && frontal;
  }

  /**
   * El giro también es una transición completa: de frente → girar → volver al
   * centro. Inclinar un teléfono con una foto genera un giro aparente, pero
   * difícilmente la secuencia completa con el rostro estable y encuadrado.
   */
  private evaluateTurn(frame: LiveFrame): boolean {
    const frontal = Math.abs(frame.yaw) < Verification.FRONTAL_YAW_MAX;

    if (!this.frontalSeen) {
      if (frontal) {
        this.frontalFrames++;
        if (this.frontalFrames >= 2) {
          this.frontalSeen = true;
          this.liveFeedback.set('Ahora gire la cabeza hacia un lado.');
        }
      } else {
        this.frontalFrames = 0;
        if (!this.liveFeedback()) {
          this.liveFeedback.set('Mire de frente a la cámara un momento.');
        }
      }
      return false;
    }

    if (!this.turnedSeen) {
      if (Math.abs(frame.yaw) > Verification.YAW_MIN) {
        this.turnedSeen = true;
        this.liveFeedback.set('Bien. Regrese la mirada al centro.');
      }
      return false;
    }

    return Math.abs(frame.yaw) < Verification.RETURN_YAW_MAX;
  }

  /** El centro del rostro debe caer dentro del óvalo guía. */
  private isInsideOval(box: { x: number; y: number; width: number; height: number }): boolean {
    const { cx, cy, rx, ry } = Verification.OVAL;
    const faceCx = box.x + box.width / 2;
    const faceCy = box.y + box.height / 2;
    const value = ((faceCx - cx) / rx) ** 2 + ((faceCy - cy) / ry) ** 2;
    return value <= 1;
  }
}
