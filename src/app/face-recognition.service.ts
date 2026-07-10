import { Injectable, signal } from '@angular/core';
import * as faceapi from '@vladmandic/face-api';

export interface LiveFrame {
  /** Qué tan abiertos están los ojos (Eye Aspect Ratio promedio). */
  eyeOpenness: number;
  /** EAR por ojo: permite exigir que un parpadeo sea bilateral. */
  eyeOpennessLeft: number;
  eyeOpennessRight: number;
  /** Probabilidad 0..1 de que la persona esté sonriendo. */
  smile: number;
  /** Giro de cabeza: negativo = un lado, positivo = el otro, ~0 = de frente. */
  yaw: number;
  /** Caja del rostro relativa al video (0..1) para posicionar la guía. */
  box: { x: number; y: number; width: number; height: number };
}

export interface AnalyzeOptions {
  /** La red de expresiones solo hace falta para el reto de la sonrisa;
   * omitirla acelera el bucle (clave para captar parpadeos naturales). */
  withExpressions?: boolean;
  /** Tamaño de entrada del detector (múltiplo de 32): menor = más rápido. */
  inputSize?: 224 | 320 | 416;
}

/**
 * Todo el procesamiento ocurre en el navegador (TensorFlow.js con WebGL).
 * No se envía ninguna imagen ni dato a un servidor.
 */
@Injectable({ providedIn: 'root' })
export class FaceRecognitionService {
  readonly modelsLoaded = signal(false);

  async loadModels(): Promise<void> {
    if (this.modelsLoaded()) return;
    const modelPath = 'models';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(modelPath),
      faceapi.nets.faceLandmark68Net.loadFromUri(modelPath),
      faceapi.nets.faceExpressionNet.loadFromUri(modelPath),
      faceapi.nets.faceRecognitionNet.loadFromUri(modelPath),
    ]);
    this.modelsLoaded.set(true);
  }

  /**
   * Descriptor facial de 128 dimensiones de la cara principal, para verificar
   * que la MISMA persona realiza todos los gestos (impide que dos personas se
   * repartan la prueba o que se interponga la foto de otra persona).
   */
  async computeDescriptor(video: HTMLVideoElement): Promise<Float32Array | null> {
    const result = await faceapi
      .detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptor();
    return result?.descriptor ?? null;
  }

  descriptorDistance(a: Float32Array, b: Float32Array): number {
    return faceapi.euclideanDistance(a, b);
  }

  private readonly sampleCanvas = document.createElement('canvas');

  /**
   * Heurística de accesorios que cubren el rostro, por análisis de color:
   * - Mascarilla: boca Y ambas mejillas difieren mucho del tono de la frente
   *   y además son uniformes entre sí (tela). Una barba no dispara la alerta
   *   porque las mejillas superiores siguen siendo piel.
   * - Lentes oscuros: ambas zonas de los ojos mucho más oscuras que la frente.
   */
  detectOcclusions(
    video: HTMLVideoElement,
    box: { x: number; y: number; width: number; height: number },
  ): { mask: boolean; sunglasses: boolean } {
    const W = 160;
    const H = 120;
    const canvas = this.sampleCanvas;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { mask: false, sunglasses: false };
    ctx.drawImage(video, 0, 0, W, H);

    const patch = (fx: number, fy: number) => {
      const cx = Math.round((box.x + fx * box.width) * W);
      const cy = Math.round((box.y + fy * box.height) * H);
      const r = 3;
      const x0 = Math.max(0, cx - r);
      const y0 = Math.max(0, cy - r);
      const w = Math.min(W - x0, r * 2);
      const h = Math.min(H - y0, r * 2);
      if (w <= 0 || h <= 0) return null;
      const data = ctx.getImageData(x0, y0, w, h).data;
      let rs = 0;
      let gs = 0;
      let bs = 0;
      const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        rs += data[i];
        gs += data[i + 1];
        bs += data[i + 2];
      }
      return { r: rs / n, g: gs / n, b: bs / n };
    };

    const forehead = patch(0.5, 0.18);
    const cheekL = patch(0.26, 0.6);
    const cheekR = patch(0.74, 0.6);
    const mouth = patch(0.5, 0.78);
    const eyeL = patch(0.31, 0.4);
    const eyeR = patch(0.69, 0.4);
    if (!forehead || !cheekL || !cheekR || !mouth || !eyeL || !eyeR) {
      return { mask: false, sunglasses: false };
    }

    type RGB = { r: number; g: number; b: number };
    const dist = (a: RGB, b: RGB) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
    const lum = (c: RGB) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

    const DIFF = 65;
    const UNIFORM = 60;
    const mask =
      dist(mouth, forehead) > DIFF &&
      dist(cheekL, forehead) > DIFF &&
      dist(cheekR, forehead) > DIFF &&
      dist(mouth, cheekL) < UNIFORM &&
      dist(mouth, cheekR) < UNIFORM;

    const fl = lum(forehead);
    const sunglasses = fl > 50 && lum(eyeL) < fl * 0.45 && lum(eyeR) < fl * 0.45;

    return { mask, sunglasses };
  }

  /**
   * Analiza el fotograma actual detectando TODAS las caras presentes.
   * Devuelve cuántas hay y las métricas de vida (ojos, sonrisa, giro) de la
   * cara principal (la de mayor tamaño), o frame null si no hay ninguna.
   * Los landmarks se calculan sobre el recorte del rostro a resolución
   * nativa, así que reducir inputSize del detector no degrada el EAR.
   */
  async analyzeFrame(
    video: HTMLVideoElement,
    options: AnalyzeOptions = {},
  ): Promise<{ faces: number; frame: LiveFrame | null }> {
    const { withExpressions = true, inputSize = 320 } = options;
    const detector = faceapi.detectAllFaces(
      video,
      new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.5 }),
    );

    const results = withExpressions
      ? await detector.withFaceLandmarks().withFaceExpressions()
      : await detector.withFaceLandmarks();

    if (results.length === 0) return { faces: 0, frame: null };

    const primary = results.reduce((a, b) =>
      a.detection.box.area >= b.detection.box.area ? a : b,
    );

    const landmarks = primary.landmarks;
    const eyeOpennessLeft = this.eyeAspectRatio(landmarks.getLeftEye());
    const eyeOpennessRight = this.eyeAspectRatio(landmarks.getRightEye());

    const box = primary.detection.box;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;

    return {
      faces: results.length,
      frame: {
        eyeOpenness: (eyeOpennessLeft + eyeOpennessRight) / 2,
        eyeOpennessLeft,
        eyeOpennessRight,
        smile: withExpressions
          ? (primary as unknown as { expressions: { happy: number } }).expressions.happy
          : 0,
        yaw: this.headYaw(landmarks),
        box: { x: box.x / vw, y: box.y / vh, width: box.width / vw, height: box.height / vh },
      },
    };
  }

  /**
   * Captura una fotografía del fotograma actual como JPEG (data URL).
   * Si se proporciona la caja del rostro (relativa 0..1), recorta la cara
   * con un margen alrededor; si no, captura el cuadro completo.
   * La imagen se genera sin efecto espejo, en la orientación real.
   */
  captureFace(
    video: HTMLVideoElement,
    box?: { x: number; y: number; width: number; height: number },
    margin = 0.45,
  ): string {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;

    if (box) {
      const mx = box.width * margin;
      const my = box.height * margin;
      sx = Math.max(0, (box.x - mx) * vw);
      sy = Math.max(0, (box.y - my) * vh);
      sw = Math.min(vw - sx, (box.width + mx * 2) * vw);
      sh = Math.min(vh - sy, (box.height + my * 2) * vh);
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  /** EAR clásico: (‖p2−p6‖ + ‖p3−p5‖) / (2·‖p1−p4‖). Ojo cerrado ≈ < 0.22. */
  private eyeAspectRatio(eye: faceapi.Point[]): number {
    const d = (a: faceapi.Point, b: faceapi.Point) => Math.hypot(a.x - b.x, a.y - b.y);
    const horizontal = d(eye[0], eye[3]);
    if (horizontal === 0) return 0;
    return (d(eye[1], eye[5]) + d(eye[2], eye[4])) / (2 * horizontal);
  }

  /**
   * Estima el giro de la cabeza comparando la distancia de la nariz a cada
   * lado de la mandíbula. 0 = de frente; |yaw| > 0.35 = cabeza girada.
   */
  private headYaw(landmarks: faceapi.FaceLandmarks68): number {
    const points = landmarks.positions;
    const nose = points[30];
    const jawLeft = points[0];
    const jawRight = points[16];
    const left = Math.abs(nose.x - jawLeft.x);
    const right = Math.abs(jawRight.x - nose.x);
    const total = left + right;
    if (total === 0) return 0;
    return (right - left) / total;
  }
}
