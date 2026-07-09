import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { AnalyzeOptions, FaceRecognitionService, LiveFrame } from './face-recognition.service';
import { PhotoStorageService } from './photo-storage.service';

/**
 * Flujo: intro (sin cámara) → popup de instrucciones → requesting-camera
 * (permiso del navegador) → positioning (centrar el rostro) → testing
 * (gestos) → success | failed. load-error cubre el fallo de los modelos.
 */
type Phase =
  | 'intro'
  | 'load-error'
  | 'requesting-camera'
  | 'camera-error'
  | 'positioning'
  | 'testing'
  | 'success'
  | 'failed';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface Challenge {
  id: 'blink' | 'smile' | 'turn';
  title: string;
  instruction: string;
  done: boolean;
}

/** Muestra del ojo para el detector de parpadeo (búfer de ~3.5 s). */
interface EyeSample {
  t: number;
  ear: number;
  earL: number;
  earR: number;
  yaw: number;
  cx: number;
  cy: number;
  w: number;
  /** Velocidades respecto a la muestra anterior, en unidades/segundo. */
  centerSpeed: number;
  widthSpeed: number;
  yawSpeed: number;
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
  private readonly prepDialogRef = viewChild<ElementRef<HTMLElement>>('prepDialog');

  constructor() {
    // Mueve el foco al diálogo de indicaciones cuando se abre.
    effect(() => {
      const dialog = this.prepDialogRef()?.nativeElement;
      if (dialog && this.showPrep()) dialog.focus();
    });
  }

  readonly phase = signal<Phase>('intro');
  readonly modelsReady = signal(false);
  readonly faceDetected = signal(false);
  readonly multipleFaces = signal(false);
  readonly faceInOval = signal(false);
  readonly challenges = signal<Challenge[]>([]);
  readonly currentIndex = signal(0);
  readonly secondsLeft = signal(0);
  readonly timerPaused = signal(false);
  readonly failReason = signal('');
  readonly retryHint = signal('');
  readonly attempts = signal(0);
  /** Guía en vivo del reto actual (siempre refleja el estado presente). */
  readonly liveFeedback = signal('');
  /** Estado del guardado de la fotografía de evidencia. */
  readonly saveState = signal<SaveState>('idle');

  /** Modo diagnóstico (abrir la app con ?debug): muestra las métricas en vivo. */
  readonly debugMode = new URLSearchParams(window.location.search).has('debug');
  readonly debugInfo = signal('');

  /** Ventana previa con recomendaciones (retirar accesorios, iluminación…). */
  readonly showPrep = signal(false);
  readonly prepSlide = signal(0);
  static readonly PREP_SLIDES = 4;
  readonly prepSlides = Array.from({ length: Verification.PREP_SLIDES }, (_, i) => i);

  /** Fotografía del rostro capturada al aprobar la verificación (data URL JPEG). */
  readonly capturedPhoto = signal<string | null>(null);

  readonly faceOk = computed(
    () => this.faceDetected() && !this.multipleFaces() && this.faceInOval(),
  );
  readonly faceBad = computed(
    () => this.faceDetected() && (this.multipleFaces() || !this.faceInOval()),
  );

  readonly current = computed<Challenge | null>(
    () => this.challenges()[this.currentIndex()] ?? null,
  );

  readonly maxAttemptsReached = computed(() => this.attempts() >= Verification.MAX_ATTEMPTS);

  /** Mensaje de guía de encuadre (positioning y testing). */
  readonly framingHint = computed(() => {
    if (!this.faceDetected()) return 'No se detecta su rostro. Colóquese frente a la cámara.';
    if (this.multipleFaces()) return 'Solo debe haber una persona frente a la cámara.';
    if (!this.faceInOval()) return 'Centre su rostro dentro del óvalo.';
    return '';
  });

  /** Un único mensaje de estado para lectores de pantalla. */
  readonly srStatus = computed(() => {
    if (this.phase() === 'testing') {
      return this.framingHint() || this.liveFeedback() || (this.current()?.instruction ?? '');
    }
    if (this.phase() === 'positioning') {
      return this.framingHint() || 'Encuadre correcto, la verificación va a comenzar.';
    }
    return '';
  });

  private lastBox: { x: number; y: number; width: number; height: number } | null = null;
  private stream: MediaStream | null = null;

  // --- Identidad: la misma persona debe realizar toda la prueba ---
  /** Descriptor facial de referencia, capturado al terminar el encuadre. */
  private referenceDescriptor: Float32Array | null = null;
  private computingReference = false;
  /** Último instante con más de una cara (histéresis contra parpadeos del detector). */
  private lastMultiFaceAt = 0;
  /** Caja del fotograma anterior del bucle de prueba, para detectar saltos. */
  private prevTickBox: { x: number; y: number; width: number; height: number } | null = null;
  private challengeStartAt = 0;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /** Elemento que abrió el popup, para devolverle el foco al cerrar. */
  private prepTrigger: HTMLElement | null = null;

  // --- Detector de parpadeo: valle y recuperación sobre un búfer temporal ---
  private eyeBuf: EyeSample[] = [];
  private blinkPhase: 'open' | 'dip' = 'open';
  private dipStart = 0;
  private dipMin = 1;

  // --- Estado de los retos de sonrisa y giro (transiciones) ---
  private neutralFrames = 0;
  private neutralSeen = false;
  private frontalFrames = 0;
  private frontalSeen = false;
  private turnedSeen = false;

  private challengeDeadline = 0;
  private settleUntil = 0;
  private stableFrames = 0;
  private faceAbsentSince = 0;
  private lastTickAt = 0;

  private static readonly MAX_ATTEMPTS = 3;
  private static readonly CHALLENGE_SECONDS = 20;
  private static readonly SETTLE_MS = 1500;
  private static readonly STABLE_FRAMES_REQUIRED = 6;
  private static readonly ABSENCE_LIMIT_MS = 3000;

  /**
   * Parpadeo (valle y recuperación). Un solo fotograma con los ojos cerrados
   * basta, validado contra una línea base robusta (percentil 75 de los
   * últimos 2.5 s) y con controles anti-suplantación por velocidad: mover o
   * inclinar un teléfono desplaza toda la imagen justo en el instante del
   * falso "cierre", cosa que un parpadeo real no hace.
   */
  private static readonly DIP_RATIO = 0.88;
  private static readonly DIP_ABSOLUTE = 0.24;
  private static readonly BILATERAL_RATIO = 0.9;
  private static readonly REOPEN_RATIO = 0.93;
  private static readonly PROMINENCE_MIN = 0.08;
  private static readonly PRE_OPEN_WINDOW_MS = 700;
  private static readonly MAX_DIP_MS = 2500;
  private static readonly BASELINE_WINDOW_MS = 2500;
  private static readonly BASELINE_MIN_SAMPLES = 8;
  private static readonly BUFFER_MS = 3500;
  /** Límites de velocidad (unidades relativas por segundo). */
  private static readonly STILL_CENTER_SPEED = 0.2;
  private static readonly STILL_WIDTH_SPEED = 0.2;
  private static readonly STILL_YAW_SPEED = 0.6;

  /** Distancia euclidiana máxima entre descriptores para ser la misma persona. */
  private static readonly IDENTITY_MAX_DISTANCE = 0.55;
  /** La alerta de varias caras persiste este tiempo tras la última detección. */
  private static readonly MULTI_FACE_HOLD_MS = 1500;
  /** Salto de posición/tamaño imposible para una cabeza real entre fotogramas:
   * indica que se interpuso otra imagen; reinicia las transiciones del gesto. */
  private static readonly TELEPORT_CENTER_DELTA = 0.18;
  private static readonly TELEPORT_WIDTH_FACTOR = 0.6;
  /** Tras estos ms sin detectar parpadeo se sugiere el cierre lento. */
  private static readonly BLINK_HINT_AFTER_MS = 8000;

  private static readonly SMILE_MIN = 0.65;
  private static readonly NEUTRAL_MAX = 0.3;
  private static readonly YAW_MIN = 0.32;
  private static readonly RETURN_YAW_MAX = 0.22;
  private static readonly FRONTAL_YAW_MAX = 0.18;
  /** Óvalo guía en coordenadas del RECUADRO visible (coincide con el CSS). */
  private static readonly OVAL = { cx: 0.5, cy: 0.5, rx: 0.28, ry: 0.42 };

  async ngOnInit(): Promise<void> {
    await this.loadModels();
  }

  async loadModels(): Promise<void> {
    this.phase.set('intro');
    try {
      await this.faceService.loadModels();
      this.modelsReady.set(true);
    } catch (e) {
      this.phase.set('load-error');
      console.error(e);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.stopCamera();
  }

  // ---- flujo: popup → cámara → posicionamiento → retos ----

  openPrep(event?: Event): void {
    this.prepTrigger = (event?.currentTarget as HTMLElement) ?? null;
    this.showPrep.set(true);
  }

  cancelPrep(): void {
    this.showPrep.set(false);
    this.prepTrigger?.focus();
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
    this.attempts.set(0);
    await this.startCamera();
  }

  async startCamera(): Promise<void> {
    if (this.stream) {
      this.beginPositioning();
      return;
    }
    this.phase.set('requesting-camera');
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
      console.error(e);
    }
  }

  private stopCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private beginPositioning(): void {
    this.stableFrames = 0;
    this.referenceDescriptor = null;
    this.computingReference = false;
    this.prevTickBox = null;
    this.lastMultiFaceAt = 0;
    this.capturedPhoto.set(null);
    this.saveState.set('idle');
    this.failReason.set('');
    this.retryHint.set('');
    this.liveFeedback.set('');
    this.phase.set('positioning');
  }

  private startTest(): void {
    // Orden aleatorio: impide superar la prueba con un video pregrabado.
    const pool: Challenge[] = [
      {
        id: 'blink',
        title: 'Parpadeo',
        instruction: 'Parpadee con naturalidad mirando de frente.',
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
        instruction: 'Mire de frente, gire lentamente la cabeza hacia un lado y regrese al centro.',
        done: false,
      },
    ];
    this.challenges.set(pool.sort(() => Math.random() - 0.5));
    this.currentIndex.set(0);
    this.lastTickAt = 0;
    this.resetChallengeState();
    this.phase.set('testing');
  }

  /** Volver a intentar: la cámara sigue encendida, regresa al encuadre. */
  retry(): void {
    if (this.maxAttemptsReached()) return;
    this.beginPositioning();
  }

  /** Terminar: apaga la cámara y vuelve a la pantalla inicial. */
  finish(): void {
    this.stopCamera();
    this.challenges.set([]);
    this.phase.set('intro');
  }

  cancelTest(): void {
    this.finish();
  }

  async retrySavePhoto(): Promise<void> {
    const photo = this.capturedPhoto();
    if (!photo) return;
    await this.savePhoto(photo);
  }

  private async savePhoto(photo: string): Promise<void> {
    this.saveState.set('saving');
    try {
      await this.photoStorage.save(photo);
      this.saveState.set('saved');
    } catch (e) {
      this.saveState.set('error');
      console.error('No se pudo guardar la foto', e);
    }
  }

  private resetChallengeState(): void {
    this.eyeBuf = [];
    this.blinkPhase = 'open';
    this.dipStart = 0;
    this.dipMin = 1;
    this.neutralFrames = 0;
    this.neutralSeen = false;
    this.frontalFrames = 0;
    this.frontalSeen = false;
    this.turnedSeen = false;
    this.faceAbsentSince = 0;
    this.prevTickBox = null;
    this.liveFeedback.set('');
    this.timerPaused.set(false);
    this.challengeStartAt = Date.now();
    this.challengeDeadline = Date.now() + Verification.CHALLENGE_SECONDS * 1000;
    this.secondsLeft.set(Verification.CHALLENGE_SECONDS);
  }

  // ---- bucle principal de análisis ----

  /**
   * Durante el parpadeo el bucle corre lo más rápido posible y sin la red de
   * expresiones (~10-14 fps): un parpadeo natural pasa solo 60-100 ms con los
   * ojos bajo el umbral y a 3-6 fps era prácticamente indetectable.
   */
  private analyzeOptions(): AnalyzeOptions {
    const challenge = this.phase() === 'testing' ? this.current() : null;
    if (challenge?.id === 'smile') return { withExpressions: true, inputSize: 320 };
    return { withExpressions: false, inputSize: 224 };
  }

  private loopDelay(): number {
    return this.phase() === 'testing' && this.current()?.id === 'blink' ? 30 : 120;
  }

  private async loop(): Promise<void> {
    if (this.destroyed || !this.stream) return;

    const video = this.videoRef().nativeElement;
    if (video.readyState >= 2) {
      let faces = 0;
      let frame: LiveFrame | null = null;
      try {
        ({ faces, frame } = await this.faceService.analyzeFrame(video, this.analyzeOptions()));
      } catch (e) {
        console.error(e);
      }
      this.faceDetected.set(faces > 0);
      // Histéresis: si hubo dos caras hace un instante, el bloqueo se mantiene
      // aunque el detector pierda a la segunda por un fotograma.
      if (faces > 1) this.lastMultiFaceAt = Date.now();
      this.multipleFaces.set(
        faces > 1 || Date.now() - this.lastMultiFaceAt < Verification.MULTI_FACE_HOLD_MS,
      );
      this.faceInOval.set(frame ? this.isInsideOval(frame.box, video) : false);
      if (frame) this.lastBox = frame.box;

      if (this.debugMode) {
        const base = this.blinkBaseline();
        this.debugInfo.set(
          frame
            ? `caras: ${faces} · EAR: ${frame.eyeOpenness.toFixed(3)} (I ${frame.eyeOpennessLeft.toFixed(2)} / D ${frame.eyeOpennessRight.toFixed(2)}) · ` +
                `base P75: ${base ? base.ear.toFixed(3) : '—'} · sonrisa: ${frame.smile.toFixed(2)} · giro: ${frame.yaw.toFixed(2)} · ` +
                `óvalo: ${this.faceInOval()} · fase parpadeo: ${this.blinkPhase}`
            : 'sin rostro',
        );
      }

      if (this.phase() === 'positioning') {
        this.stableFrames = this.faceOk() ? this.stableFrames + 1 : 0;
        if (this.stableFrames >= Verification.STABLE_FRAMES_REQUIRED && !this.computingReference) {
          // Ancla de identidad: se captura el descriptor facial de la persona
          // encuadrada; cada gesto completado se verificará contra él.
          this.computingReference = true;
          const descriptor = await this.faceService.computeDescriptor(video);
          this.computingReference = false;
          if (descriptor && this.phase() === 'positioning') {
            this.referenceDescriptor = descriptor;
            this.startTest();
          } else {
            this.stableFrames = 0;
          }
        }
      } else if (this.phase() === 'testing') {
        await this.tickTesting(frame);
      }
    }

    this.loopTimer = setTimeout(() => this.loop(), this.loopDelay());
  }

  private async tickTesting(frame: LiveFrame | null): Promise<void> {
    const now = Date.now();
    const elapsed = this.lastTickAt ? Math.min(now - this.lastTickAt, 1000) : 0;
    this.lastTickAt = now;

    // Continuidad: si el rostro desaparece demasiado tiempo (p. ej. para
    // cambiar la imagen de un teléfono), la prueba falla por completo.
    if (!frame) {
      if (this.faceAbsentSince === 0) this.faceAbsentSince = now;
      if (now - this.faceAbsentSince > Verification.ABSENCE_LIMIT_MS) {
        this.fail(
          'Su rostro dejó de ser visible durante la prueba.',
          'Manténgase frente a la cámara durante toda la verificación.',
        );
        return;
      }
    } else {
      this.faceAbsentSince = 0;
    }

    // Pausa de asentamiento entre retos: no se evalúa ni corre el tiempo.
    if (now < this.settleUntil) {
      this.challengeDeadline = now + Verification.CHALLENGE_SECONDS * 1000;
      return;
    }
    if (this.liveFeedback().startsWith('Correcto')) this.liveFeedback.set('');

    // Encuadre incorrecto: se pausa la evaluación y el temporizador
    // no avanza en su contra (se muestra "En pausa").
    if (!frame || !this.faceOk()) {
      this.challengeDeadline += elapsed;
      this.timerPaused.set(true);
      this.prevTickBox = frame?.box ?? null;
      return;
    }
    this.timerPaused.set(false);

    // Salto imposible de posición o tamaño entre fotogramas: una cabeza real
    // no se teletransporta, pero interponer un teléfono o cambiar de imagen
    // sí lo hace. Se reinician las transiciones del gesto en curso.
    if (this.prevTickBox) {
      const dcx = Math.abs(
        frame.box.x + frame.box.width / 2 - (this.prevTickBox.x + this.prevTickBox.width / 2),
      );
      const dcy = Math.abs(
        frame.box.y + frame.box.height / 2 - (this.prevTickBox.y + this.prevTickBox.height / 2),
      );
      const widthJump =
        Math.abs(frame.box.width - this.prevTickBox.width) >
        this.prevTickBox.width * Verification.TELEPORT_WIDTH_FACTOR;
      if (
        dcx > Verification.TELEPORT_CENTER_DELTA ||
        dcy > Verification.TELEPORT_CENTER_DELTA ||
        widthJump
      ) {
        this.resetGestureTransitions();
      }
    }
    this.prevTickBox = frame.box;

    this.secondsLeft.set(Math.max(0, Math.ceil((this.challengeDeadline - now) / 1000)));
    if (now > this.challengeDeadline) {
      this.fail(
        'El tiempo para realizar el gesto se agotó.',
        'Realice el gesto en cuanto aparezca la indicación en pantalla.',
      );
      return;
    }

    await this.evaluate(frame, now);
  }

  /** Reinicia las transiciones del gesto en curso sin tocar el temporizador. */
  private resetGestureTransitions(): void {
    this.eyeBuf = [];
    this.blinkPhase = 'open';
    this.neutralFrames = 0;
    this.neutralSeen = false;
    this.frontalFrames = 0;
    this.frontalSeen = false;
    this.turnedSeen = false;
  }

  private fail(reason: string, hint: string): void {
    this.attempts.update((n) => n + 1);
    this.failReason.set(reason);
    this.retryHint.set(
      this.maxAttemptsReached()
        ? 'Se alcanzó el número máximo de intentos. Intente más tarde o desde otro dispositivo.'
        : hint,
    );
    this.phase.set('failed');
  }

  private async evaluate(frame: LiveFrame, now: number): Promise<void> {
    const challenge = this.current();
    if (!challenge) return;

    let passed = false;
    switch (challenge.id) {
      case 'blink':
        passed = this.evaluateBlink(frame, now);
        break;
      case 'smile':
        passed = this.evaluateSmile(frame);
        break;
      case 'turn':
        passed = this.evaluateTurn(frame);
        break;
    }

    if (!passed) return;

    // La MISMA persona del encuadre inicial debe completar cada gesto: esto
    // impide que dos personas se repartan la prueba o que se muestre la foto
    // de otra persona en un teléfono para el gesto final.
    if (!(await this.verifyIdentity())) {
      this.fail(
        'Se detectó un cambio de rostro durante la prueba.',
        'La misma persona debe permanecer frente a la cámara y realizar todos los gestos, sin interponer imágenes.',
      );
      return;
    }

    // La fotografía de evidencia se toma en el instante en que se detecta la
    // sonrisa, para que la persona salga sonriendo.
    if (challenge.id === 'smile') {
      const photo = this.faceService.captureFace(this.videoRef().nativeElement, frame.box);
      this.capturedPhoto.set(photo);
      void this.savePhoto(photo);
    }

    this.challenges.update((list) =>
      list.map((c, i) => (i === this.currentIndex() ? { ...c, done: true } : c)),
    );

    if (this.currentIndex() + 1 >= this.challenges().length) {
      if (!this.capturedPhoto()) {
        const photo = this.faceService.captureFace(
          this.videoRef().nativeElement,
          this.lastBox ?? undefined,
        );
        this.capturedPhoto.set(photo);
        void this.savePhoto(photo);
      }
      this.liveFeedback.set('');
      this.phase.set('success');
      // La cámara se apaga en cuanto deja de ser necesaria (señal de
      // confianza en un flujo de identidad).
      this.stopCamera();
    } else {
      this.currentIndex.update((i) => i + 1);
      this.resetChallengeState();
      // Pausa entre retos: el gesto anterior no contamina el siguiente.
      this.settleUntil = Date.now() + Verification.SETTLE_MS;
      this.liveFeedback.set('Correcto. Prepárese para la siguiente indicación…');
    }
  }

  /**
   * Compara el rostro actual contra el descriptor de referencia capturado en
   * el encuadre. Dos intentos por si el cómputo falla transitoriamente.
   */
  private async verifyIdentity(): Promise<boolean> {
    if (!this.referenceDescriptor) return false;
    const video = this.videoRef().nativeElement;
    for (let attempt = 0; attempt < 2; attempt++) {
      const descriptor = await this.faceService.computeDescriptor(video);
      if (descriptor) {
        return (
          this.faceService.descriptorDistance(this.referenceDescriptor, descriptor) <
          Verification.IDENTITY_MAX_DISTANCE
        );
      }
    }
    return false;
  }

  // ---- parpadeo: detector de valle y recuperación ----

  /** Línea base robusta: percentil 75 de las muestras frontales recientes. */
  private blinkBaseline(): { ear: number; earL: number; earR: number } | null {
    const cutoff = Date.now() - Verification.BASELINE_WINDOW_MS;
    const frontal = this.eyeBuf.filter(
      (s) => s.t >= cutoff && Math.abs(s.yaw) <= Verification.FRONTAL_YAW_MAX,
    );
    if (frontal.length < Verification.BASELINE_MIN_SAMPLES) return null;
    return {
      ear: this.percentile(frontal.map((s) => s.ear), 75),
      earL: this.percentile(frontal.map((s) => s.earL), 75),
      earR: this.percentile(frontal.map((s) => s.earR), 75),
    };
  }

  private percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  private pushEyeSample(frame: LiveFrame, now: number): EyeSample {
    const prev = this.eyeBuf[this.eyeBuf.length - 1];
    const cx = frame.box.x + frame.box.width / 2;
    const cy = frame.box.y + frame.box.height / 2;
    let centerSpeed = 0;
    let widthSpeed = 0;
    let yawSpeed = 0;
    if (prev) {
      const dt = Math.max(0.016, (now - prev.t) / 1000);
      centerSpeed = Math.hypot(cx - prev.cx, cy - prev.cy) / dt;
      widthSpeed = Math.abs(frame.box.width - prev.w) / dt;
      yawSpeed = Math.abs(frame.yaw - prev.yaw) / dt;
    }
    const sample: EyeSample = {
      t: now,
      ear: frame.eyeOpenness,
      earL: frame.eyeOpennessLeft,
      earR: frame.eyeOpennessRight,
      yaw: frame.yaw,
      cx,
      cy,
      w: frame.box.width,
      centerSpeed,
      widthSpeed,
      yawSpeed,
    };
    this.eyeBuf.push(sample);
    const cutoff = now - Verification.BUFFER_MS;
    while (this.eyeBuf.length && this.eyeBuf[0].t < cutoff) this.eyeBuf.shift();
    return sample;
  }

  private isSampleStill(s: EyeSample): boolean {
    return (
      s.centerSpeed < Verification.STILL_CENTER_SPEED &&
      s.widthSpeed < Verification.STILL_WIDTH_SPEED &&
      s.yawSpeed < Verification.STILL_YAW_SPEED
    );
  }

  /** Mediana de las velocidades en la ventana previa al valle. */
  private preDipWindowStill(now: number): boolean {
    const windowSamples = this.eyeBuf.filter(
      (s) => s.t >= now - Verification.PRE_OPEN_WINDOW_MS && s.t < now,
    );
    if (windowSamples.length < 2) return false;
    const median = (values: number[]) => this.percentile(values, 50);
    return (
      median(windowSamples.map((s) => s.centerSpeed)) < Verification.STILL_CENTER_SPEED &&
      median(windowSamples.map((s) => s.widthSpeed)) < Verification.STILL_WIDTH_SPEED &&
      median(windowSamples.map((s) => s.yawSpeed)) < Verification.STILL_YAW_SPEED
    );
  }

  private evaluateBlink(frame: LiveFrame, now: number): boolean {
    if (Math.abs(frame.yaw) > Verification.FRONTAL_YAW_MAX) {
      this.blinkPhase = 'open';
      this.liveFeedback.set('Mire de frente a la cámara.');
      return false;
    }

    const sample = this.pushEyeSample(frame, now);
    const base = this.blinkBaseline();
    if (!base) {
      this.liveFeedback.set('Mantenga la mirada al frente un momento…');
      return false;
    }

    const ratio = sample.ear / base.ear;

    if (this.blinkPhase === 'open') {
      const isDip = ratio <= Verification.DIP_RATIO || sample.ear <= Verification.DIP_ABSOLUTE;
      const bilateral =
        sample.earL / base.earL <= Verification.BILATERAL_RATIO &&
        sample.earR / base.earR <= Verification.BILATERAL_RATIO;
      const openRecently = this.eyeBuf.some(
        (s) =>
          s.t >= now - Verification.PRE_OPEN_WINDOW_MS &&
          s.t < now &&
          s.ear / base.ear >= Verification.REOPEN_RATIO,
      );
      if (
        isDip &&
        bilateral &&
        this.isSampleStill(sample) &&
        this.preDipWindowStill(now) &&
        openRecently
      ) {
        this.blinkPhase = 'dip';
        this.dipStart = now;
        this.dipMin = sample.ear;
        this.liveFeedback.set('Ojos cerrados detectados…');
      } else if (now - this.challengeStartAt > Verification.BLINK_HINT_AFTER_MS) {
        this.liveFeedback.set('También puede cerrar los ojos un instante y volver a abrirlos.');
      } else {
        this.liveFeedback.set('');
      }
      return false;
    }

    // fase 'dip': esperando la reapertura
    this.dipMin = Math.min(this.dipMin, sample.ear);
    if (now - this.dipStart > Verification.MAX_DIP_MS) {
      this.blinkPhase = 'open';
      this.liveFeedback.set('Abra los ojos y parpadee de nuevo.');
      return false;
    }
    const prominence = (base.ear - this.dipMin) / base.ear;
    if (ratio >= Verification.REOPEN_RATIO && prominence >= Verification.PROMINENCE_MIN) {
      return true;
    }
    return false;
  }

  // ---- sonrisa y giro: transiciones obligatorias ----

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
        this.liveFeedback.set('Primero mire de frente con gesto serio, sin sonreír.');
      }
      return false;
    }

    if (!frontal) {
      this.liveFeedback.set('Mire de frente y sonría ampliamente.');
      return false;
    }
    return frame.smile > Verification.SMILE_MIN;
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
        this.liveFeedback.set('Mire de frente a la cámara un momento.');
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

  /**
   * El centro del rostro debe caer dentro del óvalo guía. El óvalo del CSS
   * vive en coordenadas del recuadro visible; con object-fit: cover el video
   * puede estar recortado, así que se convierte a coordenadas del video real.
   */
  private isInsideOval(
    box: { x: number; y: number; width: number; height: number },
    video: HTMLVideoElement,
  ): boolean {
    const { cx, cy, rx, ry } = Verification.OVAL;
    let rxVideo = rx;
    let ryVideo = ry;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const dw = video.clientWidth;
    const dh = video.clientHeight;
    if (vw && vh && dw && dh) {
      const scale = Math.max(dw / vw, dh / vh);
      rxVideo = (rx * dw) / (scale * vw);
      ryVideo = (ry * dh) / (scale * vh);
    }
    const faceCx = box.x + box.width / 2;
    const faceCy = box.y + box.height / 2;
    const value = ((faceCx - cx) / rxVideo) ** 2 + ((faceCy - cy) / ryVideo) ** 2;
    return value <= 1;
  }
}
