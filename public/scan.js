/* global cv, jscanify */
// Reconhecimento de bordas (jscanify sobre OpenCV.js), correcao de perspectiva e filtros de documento.
(function () {
  'use strict';

  // Máscara de nitidez (unsharp): realça bordas do texto sem estourar. Mat in-place.
  function unsharpen(mat) {
    let blur;
    try {
      blur = new cv.Mat();
      cv.GaussianBlur(mat, blur, new cv.Size(0, 0), 2.5);
      cv.addWeighted(mat, 1.5, blur, -0.5, 0, mat);
    } catch {
      /* sem nitidez se falhar */
    } finally {
      if (blur) blur.delete();
    }
  }

  const Scanner = {
    ready: false,
    scanner: null,

    /** Aguarda o OpenCV.js inicializar (build emscripten de docs.opencv.org). */
    loadOpenCV() {
      return new Promise((resolve, reject) => {
        if (this.ready) return resolve();
        const done = () => {
          try {
            this.scanner = new jscanify();
            this.ready = true;
            resolve();
          } catch (e) {
            reject(e);
          }
        };
        const isReady = () => window.cv && typeof window.cv.Mat === 'function';
        if (isReady()) return done();

        // cv pode ser um objeto que dispara onRuntimeInitialized, ou (em alguns builds) uma Promise.
        const tryHook = () => {
          if (window.cv && window.cv instanceof Promise) {
            window.cv.then((m) => {
              window.cv = m;
            });
          } else if (window.cv && typeof window.cv === 'object') {
            window.cv['onRuntimeInitialized'] = () => {
              if (isReady()) done();
            };
          }
        };
        tryHook();

        let tries = 0;
        const iv = setInterval(() => {
          if (isReady()) {
            clearInterval(iv);
            done();
          } else if (++tries > 600) {
            // ~60s
            clearInterval(iv);
            reject(new Error('Timeout ao carregar OpenCV.js'));
          } else {
            tryHook();
          }
        }, 100);
      });
    },

    /**
     * A partir de um canvas de origem (frame da camera ou imagem carregada),
     * detecta o papel e devolve um canvas corrigido em perspectiva.
     * Se nao encontrar contorno, devolve o proprio frame.
     */
    extractPaper(sourceCanvas) {
      if (!this.ready || !this.scanner) return sourceCanvas;
      let srcMat = null;
      let contour = null;
      try {
        srcMat = cv.imread(sourceCanvas);
        contour = this.scanner.findPaperContour(srcMat);
        if (!contour) return sourceCanvas;
        const corners = this.scanner.getCornerPoints(contour);
        if (!corners || !corners.topLeftCorner) return sourceCanvas;
        const c = corners;

        const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        const wTop = dist(c.topLeftCorner, c.topRightCorner);
        const wBot = dist(c.bottomLeftCorner, c.bottomRightCorner);
        const hL = dist(c.topLeftCorner, c.bottomLeftCorner);
        const hR = dist(c.topRightCorner, c.bottomRightCorner);
        let W = Math.round(Math.max(wTop, wBot));
        let H = Math.round(Math.max(hL, hR));
        if (!W || !H || W < 40 || H < 40) return sourceCanvas;

        // Area do quadrilatero detectado (formula do shoelace) vs area do quadro.
        // Se for pequeno demais, provavelmente pegou uma moldura interna (ex.: a tabela
        // de um recibo) e cortaria dados -> nao recorta, deixa o usuario decidir no preview.
        const poly = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner];
        let area2 = 0;
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i];
          const q = poly[(i + 1) % poly.length];
          area2 += p.x * q.y - q.x * p.y;
        }
        const detArea = Math.abs(area2) / 2;
        const frameArea = sourceCanvas.width * sourceCanvas.height;
        if (frameArea > 0 && detArea / frameArea < 0.5) return sourceCanvas;
        // limita resolucao para nao estourar memoria em tablets
        const MAX = 2200;
        const scale = Math.min(1, MAX / Math.max(W, H));
        W = Math.round(W * scale);
        H = Math.round(H * scale);
        return this.scanner.extractPaper(sourceCanvas, W, H, corners);
      } catch {
        return sourceCanvas;
      } finally {
        if (srcMat && !srcMat.isDeleted()) srcMat.delete();
        if (contour && contour.delete && !contour.isDeleted()) contour.delete();
      }
    },

    /**
     * Detecta os 4 cantos do documento no frame e devolve
     * {topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner} em pixels da origem,
     * ou null se nao encontrar.
     *
     * Pipeline proprio (mais preciso que o metodo de extremos do jscanify):
     * cinza -> blur -> Canny -> dilata -> contornos -> approxPolyDP (quadrilatero real).
     * Se nao achar um quad convexo, cai no minAreaRect do maior contorno (robusto a
     * bordas parciais/oclusao). Retorna os cantos ORDENADOS (TL,TR,BR,BL).
     */
    detectCorners(sourceCanvas) {
      if (!this.ready) return null;
      // Detecta numa cópia reduzida (rápido mesmo em frames 4K) e reescala os
      // cantos de volta p/ a resolução original — a captura final continua em 4K.
      let work = sourceCanvas;
      let scaleBack = 1;
      const maxSide = Math.max(sourceCanvas.width, sourceCanvas.height);
      const DETECT_MAX = 1600;
      if (maxSide > DETECT_MAX) {
        const s = DETECT_MAX / maxSide;
        const tmp = document.createElement('canvas');
        tmp.width = Math.round(sourceCanvas.width * s);
        tmp.height = Math.round(sourceCanvas.height * s);
        tmp.getContext('2d').drawImage(sourceCanvas, 0, 0, tmp.width, tmp.height);
        work = tmp;
        scaleBack = 1 / s;
      }
      const mats = [];
      const t = (m) => (mats.push(m), m);
      let contours = null;
      let hierarchy = null;
      try {
        const src = t(cv.imread(work));
        const gray = t(new cv.Mat());
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
        const blur = t(new cv.Mat());
        cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
        const edges = t(new cv.Mat());
        cv.Canny(blur, edges, 60, 180);
        const k = t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
        cv.dilate(edges, edges, k);

        contours = new cv.MatVector();
        hierarchy = new cv.Mat();
        cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

        const frameArea = work.width * work.height;
        const minArea = frameArea * 0.12;
        let bestQuad = null;
        let bestQuadArea = 0;
        let bestBox = null; // fallback (minAreaRect do maior contorno)
        let bestBoxArea = 0;

        for (let i = 0; i < contours.size(); i++) {
          const cnt = contours.get(i);
          const area = cv.contourArea(cnt);
          if (area >= minArea) {
            const peri = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true); // (curve, approxCurve, epsilon, closed)
            if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestQuadArea) {
              const pts = [];
              for (let r = 0; r < 4; r++) pts.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
              bestQuad = pts;
              bestQuadArea = area;
            }
            approx.delete();
            if (area > bestBoxArea) {
              const rect = cv.minAreaRect(cnt);
              const box = cv.RotatedRect.points(rect);
              bestBox = box.map((p) => ({ x: p.x, y: p.y }));
              bestBoxArea = area;
            }
          }
          cnt.delete();
        }

        // Prioriza RETANGULO: so aceita o quad do approxPolyDP se os angulos internos
        // estiverem perto de 90 (documento reto/retangular). Se for "estranho" (muito
        // torto), usa o minAreaRect, que e sempre um retangulo limpo. O ajuste manual
        // (arrastar os cantos) continua livre p/ corrigir perspectiva.
        const angleDeviation = (pts) => {
          let maxDev = 0;
          for (let i = 0; i < 4; i++) {
            const a = pts[(i + 3) % 4];
            const b = pts[i];
            const c = pts[(i + 1) % 4];
            const v1x = a.x - b.x;
            const v1y = a.y - b.y;
            const v2x = c.x - b.x;
            const v2y = c.y - b.y;
            const dot = v1x * v2x + v1y * v2y;
            const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9;
            const ang = (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI;
            maxDev = Math.max(maxDev, Math.abs(ang - 90));
          }
          return maxDev;
        };
        const quadIsRectish = bestQuad && angleDeviation(bestQuad) <= 22; // tolera perspectiva leve
        const chosen = quadIsRectish ? bestQuad : bestBox || bestQuad;
        if (!chosen) return null;

        // ordena TL,TR,BR,BL
        const bySum = [...chosen].sort((a, b) => a.x + a.y - (b.x + b.y));
        const byDiff = [...chosen].sort((a, b) => a.x - a.y - (b.x - b.y));
        const c = {
          topLeftCorner: bySum[0],
          bottomRightCorner: bySum[3],
          bottomLeftCorner: byDiff[0],
          topRightCorner: byDiff[3],
        };

        // valida area minima (shoelace)
        const poly = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner];
        let a2 = 0;
        for (let i = 0; i < 4; i++) {
          const p = poly[i];
          const q = poly[(i + 1) % 4];
          a2 += p.x * q.y - q.x * p.y;
        }
        if (frameArea > 0 && Math.abs(a2) / 2 / frameArea < 0.1) return null;
        // reescala os cantos de volta p/ a resolução original do frame
        if (scaleBack !== 1) {
          for (const key of Object.keys(c)) {
            c[key] = { x: c[key].x * scaleBack, y: c[key].y * scaleBack };
          }
        }
        return c;
      } catch {
        return null;
      } finally {
        mats.forEach((m) => {
          if (m && m.delete && !m.isDeleted()) m.delete();
        });
        if (contours && !contours.isDeleted()) contours.delete();
        if (hierarchy && !hierarchy.isDeleted()) hierarchy.delete();
      }
    },

    /** Recorta + corrige perspectiva usando cantos fornecidos (do editor). */
    warpToCorners(sourceCanvas, corners) {
      if (!this.ready || !this.scanner || !corners) return sourceCanvas;
      try {
        const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        const wTop = dist(corners.topLeftCorner, corners.topRightCorner);
        const wBot = dist(corners.bottomLeftCorner, corners.bottomRightCorner);
        const hL = dist(corners.topLeftCorner, corners.bottomLeftCorner);
        const hR = dist(corners.topRightCorner, corners.bottomRightCorner);
        let W = Math.round(Math.max(wTop, wBot));
        let H = Math.round(Math.max(hL, hR));
        if (!W || !H || W < 40 || H < 40) return sourceCanvas;
        const MAX = 3500;
        const s = Math.min(1, MAX / Math.max(W, H));
        W = Math.round(W * s);
        H = Math.round(H * s);
        return this.scanner.extractPaper(sourceCanvas, W, H, corners);
      } catch {
        return sourceCanvas;
      }
    },

    /** Aplica o filtro de "documento" e devolve um novo canvas. */
    applyFilter(sourceCanvas, mode) {
      if (mode === 'none' || !this.ready) return sourceCanvas;
      let src, dst;
      try {
        src = cv.imread(sourceCanvas);
        dst = new cv.Mat();
        if (mode === 'bw') {
          cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);
          cv.adaptiveThreshold(
            dst,
            dst,
            255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv.THRESH_BINARY,
            21,
            12,
          );
        } else if (mode === 'gray') {
          cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);
          // CLAHE: equalização adaptativa (fundo mais branco, texto mais preto)
          try {
            const clahe = cv.createCLAHE(2.0, new cv.Size(8, 8));
            clahe.apply(dst, dst);
            clahe.delete();
          } catch {
            cv.convertScaleAbs(dst, dst, 1.25, 12); // fallback
          }
          unsharpen(dst); // nitidez
        } else {
          // color: realce de contraste/brilho preservando a cor + nitidez
          src.convertTo(dst, -1, 1.18, 8);
          unsharpen(dst);
        }
        const out = document.createElement('canvas');
        cv.imshow(out, dst);
        return out;
      } catch {
        return sourceCanvas;
      } finally {
        if (src) src.delete();
        if (dst) dst.delete();
      }
    },
  };

  window.Scanner = Scanner;
})();
