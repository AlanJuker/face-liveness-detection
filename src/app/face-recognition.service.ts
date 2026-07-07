import { Injectable, signal } from '@angular/core';
import * as faceapi from '@vladmandic/face-api';

export interface LiveFrame {
  /** Qué tan abiertos están los ojos (Eye Aspect Ratio promedio). */
  eyeOpenness: number;
  /** Probabilidad 0..1 de que la persona esté sonriendo. */
  smile: number;
  /** Giro de cabeza: negativo = un lado, positivo = el otro, ~0 = de frente. */
  yaw: number;
  /** Caja del rostro relativa al video (0..1) para posicionar la guía. */
  box: { x: number; y: number; width: number; height: number };
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
    ]);
    this.modelsLoaded.set(true);
  }

  /**
   * Analiza el fotograma actual detectando TODAS las caras presentes.
   * Devuelve cuántas hay y las métricas de vida (ojos, sonrisa, giro) de la
   * cara principal (la de mayor tamaño), o frame null si no hay ninguna.
   */
  async analyzeFrame(video: HTMLVideoElement): Promise<{ faces: number; frame: LiveFrame | null }> {
    const results = await faceapi
      .detectAllFaces(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }),
      )
      .withFaceLandmarks()
      .withFaceExpressions();

    if (results.length === 0) return { faces: 0, frame: null };

    const primary = results.reduce((a, b) =>
      a.detection.box.area >= b.detection.box.area ? a : b,
    );

    const landmarks = primary.landmarks;
    const eyeOpenness =
      (this.eyeAspectRatio(landmarks.getLeftEye()) +
        this.eyeAspectRatio(landmarks.getRightEye())) /
      2;

    const box = primary.detection.box;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;

    return {
      faces: results.length,
      frame: {
        eyeOpenness,
        smile: primary.expressions.happy,
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
