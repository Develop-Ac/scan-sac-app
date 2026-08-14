/* global Scanner, CaptureQueue, PendingQueue, SentDocs */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '';
  const CUIABA_OFFSET_MIN = -240; // UTC-4 fixo
  let currentFilter = 'gray'; // cor padrão = cinza

  // ---------- utilidades ----------
  function todayCuiaba() {
    return new Date(Date.now() + CUIABA_OFFSET_MIN * 60000).toISOString().slice(0, 10);
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  function toast(msg, kind, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), ms);
  }
  const canvasToBlob = (cnv, q = 0.9) =>
    new Promise((res) => cnv.toBlob((b) => res(b), 'image/jpeg', q));
  function makeThumb(cnv, maxW = 200) {
    const scale = Math.min(1, maxW / cnv.width);
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(cnv.width * scale));
    t.height = Math.max(1, Math.round(cnv.height * scale));
    t.getContext('2d').drawImage(cnv, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.6);
  }
  async function blobToCanvas(blob) {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    // onload (não decode): dispara mesmo com a aba/painel oculto ou em transição.
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('Falha ao ler a imagem.'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    return c;
  }

  // ---------- navegação entre telas ----------
  function showScreen(name) {
    ['home', 'camera', 'analysis'].forEach((s) => {
      $('screen-' + s).hidden = s !== name;
      $('screen-' + s).classList.toggle('active', s === name);
    });
    if (name === 'camera') startCamera();
    else stopCamera();
    if (name === 'home') refreshHome();
  }

  // ---------- service worker + instalação ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  let deferredPrompt = null;
  // iPhone/iPad/iPod não suportam instalação programática (Safari não dispara
  // beforeinstallprompt). iPadOS 13+ se identifica como "MacIntel" com toque.
  const isIOS =
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // App já rodando instalado (standalone) — não faz sentido oferecer instalar.
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function podeMostrarInstalar() {
    if (isIOS) return false; // iPhone: nunca mostra o balão
    if (isStandalone) return false; // já aberto como app instalado
    if (localStorage.getItem('appInstalled') === '1') return false; // instalado antes
    if (localStorage.getItem('installDismissed') === '1') return false; // usuário dispensou
    return true;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (podeMostrarInstalar()) $('installBalloon').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    $('installBalloon').hidden = true;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  });
  $('installDismiss').addEventListener('click', () => {
    $('installBalloon').hidden = true;
    localStorage.setItem('installDismissed', '1');
  });
  window.addEventListener('appinstalled', () => {
    $('installBalloon').hidden = true;
    localStorage.setItem('appInstalled', '1'); // não reaparece após instalar
    deferredPrompt = null;
  });

  // ---------- rede ----------
  function updateNet() {
    const on = navigator.onLine;
    const b = $('netBadge');
    b.textContent = on ? 'online' : 'offline';
    b.className = 'badge ' + (on ? 'badge-on' : 'badge-off');
    if (on) syncPending();
  }
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);

  // =======================================================================
  //  HOME (Enviados + pendentes + ícone da fila)
  // =======================================================================
  async function refreshHome() {
    await refreshQueueIcon();
    await refreshPending();
    loadEnviados();
  }

  async function refreshQueueIcon() {
    const items = await CaptureQueue.all();
    const n = items.length;
    $('queueBadge').textContent = n;
    $('queueIcon').hidden = n === 0;
    const thumb = n ? items[items.length - 1].thumb : null;
    const img = $('queueThumb');
    if (thumb) {
      img.src = thumb;
      img.hidden = false;
    } else {
      img.hidden = true;
    }
    // espelha no botão da câmera
    $('camQueueBadge').textContent = n;
    $('camQueueBtn').hidden = n === 0;
    if (thumb) $('camQueueThumb').src = thumb;
  }

  async function refreshPending() {
    const items = await PendingQueue.all();
    $('pendCount').textContent = items.length;
    $('pendingSection').hidden = items.length === 0;
    const list = $('pendingList');
    list.innerHTML = '';
    items.forEach((rec) => {
      list.appendChild(
        docRow({
          thumb: rec.thumb,
          docDate: rec.docDate,
          docType: rec.docType,
          typeLabel: labelOf(rec.docType),
          descricao: rec.descricao,
          right: 'pendente',
          rightClass: 'tag-warn',
        }),
      );
    });
  }

  // Tipos de documento do SAC. Esta lista manda no app inteiro: os cards da home,
  // o <select> da analise e o filtro dos enviados saem todos daqui.
  // `icon` aponta para um <symbol> do sprite em index.html.
  // `retorno` so muda a cor do card (fluxo de volta: devolucao/garantia).
  const TYPES = [
    { id: 'nota-fiscal', label: 'Nota Fiscal', icon: 'ico-nota-fiscal', hint: 'NF-e de venda' },
    { id: 'cupom-fiscal', label: 'Cupom Fiscal', icon: 'ico-cupom-fiscal', hint: 'Cupom do PDV' },
    { id: 'ni', label: 'N.I', icon: 'ico-ni', hint: 'Nota interna' },
    {
      id: 'nota-devolucao',
      label: 'Nota de Devolução',
      icon: 'ico-nota-devolucao',
      hint: 'Retorno de mercadoria',
      retorno: true,
    },
    {
      id: 'ni-devolucao',
      label: 'N.I de Devolução',
      icon: 'ico-ni-devolucao',
      hint: 'Nota interna de retorno',
      retorno: true,
    },
    {
      id: 'ni-garantia',
      label: 'N.I de Garantia',
      icon: 'ico-ni-garantia',
      hint: 'Troca em garantia',
      retorno: true,
    },
  ];
  const typeOf = (id) => TYPES.find((x) => x.id === id) || null;
  function labelOf(id) {
    const t = typeOf(id);
    return t ? t.label : id;
  }
  // <svg> com o icone do tipo (sprite em index.html). Sem `id` -> icone genérico.
  function typeIconSvg(id) {
    const t = typeOf(id);
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${
      t ? t.icon : 'ico-nota-fiscal'
    }"/></svg>`;
  }

  function docRow(o) {
    const div = document.createElement('div');
    div.className = 'doc-row';
    const left = document.createElement('div');
    left.className = 'doc-left';
    if (o.thumb) {
      const img = document.createElement('img');
      img.className = 'doc-thumb';
      img.src = o.thumb;
      left.appendChild(img);
    } else {
      // Sem miniatura (enviados vindos do servidor): o ícone do tipo já identifica.
      const ph = document.createElement('div');
      ph.className = 'doc-thumb doc-thumb-ph';
      ph.innerHTML = typeIconSvg(o.docType);
      left.appendChild(ph);
    }
    const info = document.createElement('div');
    info.className = 'doc-info';
    // No SAC o tipo é o que identifica o documento; data e descrição vêm abaixo.
    const meta = [dataBr(o.docDate) || '—', o.descricao || ''].filter(Boolean).join(' · ');
    info.innerHTML =
      `<strong>${esc(o.typeLabel || labelOf(o.docType))}</strong>` +
      `<div class="meta-line">${esc(meta)}</div>`;
    left.appendChild(info);
    div.appendChild(left);
    if (o.onOpen) {
      const b = document.createElement('button');
      b.className = 'btn btn-ghost btn-sm';
      b.textContent = 'abrir';
      b.addEventListener('click', o.onOpen);
      div.appendChild(b);
    } else if (o.right) {
      const tag = document.createElement('span');
      tag.className = 'doc-tag ' + (o.rightClass || '');
      tag.textContent = o.right;
      div.appendChild(tag);
    }
    return div;
  }

  function enviadosQuery() {
    const p = new URLSearchParams();
    if ($('fFrom').value) p.set('from', $('fFrom').value);
    if ($('fTo').value) p.set('to', $('fTo').value);
    if ($('fTipo').value) p.set('docType', $('fTipo').value);
    return p.toString();
  }

  async function loadEnviados() {
    $('enviadosStatus').textContent = 'Carregando…';
    const list = $('enviadosList');
    list.innerHTML = '';
    try {
      const data = await fetch(API + '/api/documents?' + enviadosQuery()).then((r) => r.json());
      const docs = data.documents || [];
      $('enviadosStatus').textContent = docs.length ? '' : 'Nada enviado ainda.';
      docs.forEach((d) => {
        list.appendChild(
          docRow({
            thumb: null,
            docDate: d.docDate,
            docType: d.docType,
            // Rótulo nosso quando o tipo é conhecido; o do servidor só cobre
            // documentos antigos/de outro app que não estão em TYPES.
            typeLabel: typeOf(d.docType) ? labelOf(d.docType) : d.docTypeLabel || d.docType,
            descricao: d.descricao,
            onOpen: () => openDoc(d.key),
          }),
        );
      });
    } catch {
      // offline: usa histórico local
      const hist = await SentDocs.all();
      $('enviadosStatus').textContent = hist.length
        ? 'Sem conexão — mostrando os enviados por este dispositivo.'
        : 'Sem conexão e sem histórico local.';
      hist.forEach((d) => {
        list.appendChild(
          docRow({
            thumb: d.thumb,
            docDate: d.docDate,
            docType: d.docType,
            typeLabel: labelOf(d.docType),
            descricao: d.descricao,
            onOpen: () => openDoc(d.key),
          }),
        );
      });
    }
  }

  async function openDoc(key) {
    try {
      const { url } = await fetch(API + '/api/documents/url?key=' + encodeURIComponent(key)).then((r) =>
        r.json(),
      );
      if (url) window.open(url, '_blank');
      else throw new Error('sem url');
    } catch {
      toast('Não foi possível abrir (sem conexão?).', 'err');
    }
  }

  // ---------- escolha do tipo (cards da home) ----------
  // Grade de tipos: é a ação principal do app. Tocar num card leva à folha de modo
  // e daí à câmera, já com o tipo definido — o usuário escolhe com o papel na mão.
  function renderTypeGrid() {
    const grid = $('typeGrid');
    grid.innerHTML = '';
    TYPES.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'type-card' + (t.retorno ? ' is-retorno' : '');
      b.innerHTML =
        `<span class="type-ico">${typeIconSvg(t.id)}</span>` +
        `<span class="type-name">${esc(t.label)}</span>` +
        `<span class="type-hint">${esc(t.hint || '')}</span>`;
      b.addEventListener('click', () => askCaptureMode(t.id));
      grid.appendChild(b);
    });
  }

  // ---------- modo de captura (escolhido após o tipo) ----------
  // 'onePdf' = todas as fotos da sessão viram 1 PDF; 'perPage' = 1 PDF por foto.
  let captureMode = 'perPage';
  let captureSession = null; // agrupa as fotos 'onePdf' de uma mesma sessão
  let captureType = ''; // tipo escolhido na home; vai junto de cada captura

  function updateCamModeChip() {
    const chip = $('camModeChip');
    chip.hidden = false;
    const modo = captureMode === 'onePdf' ? '1 PDF' : '1 por página';
    chip.textContent = `${labelOf(captureType)} · ${modo}`;
  }
  function askCaptureMode(typeId) {
    captureType = typeId;
    const t = typeOf(typeId);
    $('modeSheetType').textContent = t ? t.label : typeId;
    $('modeSheetUse').setAttribute('href', '#' + (t ? t.icon : 'ico-nota-fiscal'));
    $('modeSheetIco').classList.toggle('is-retorno', !!(t && t.retorno));
    $('modeSheet').hidden = false;
  }
  function startCaptureMode(mode) {
    captureMode = mode;
    captureSession = uuid();
    $('modeSheet').hidden = true;
    updateCamModeChip();
    showScreen('camera');
  }
  $('modeOnePdf').addEventListener('click', () => startCaptureMode('onePdf'));
  $('modePerPage').addEventListener('click', () => startCaptureMode('perPage'));
  $('modeCancel').addEventListener('click', () => ($('modeSheet').hidden = true));
  $('modeSheet').addEventListener('click', (e) => {
    if (e.target === $('modeSheet')) $('modeSheet').hidden = true; // toca fora fecha
  });

  $('queueIcon').addEventListener('click', () => openAnalysis());
  $('refreshBtn').addEventListener('click', loadEnviados);
  ['fFrom', 'fTo', 'fTipo'].forEach((id) => $(id).addEventListener('change', loadEnviados));
  $('syncAllBtn').addEventListener('click', () => {
    toast('Sincronizando…', null, 1200);
    syncPending(true);
  });

  // ---------- envio + pendentes ----------
  async function uploadRecord(rec) {
    const fd = new FormData();
    // iOS Safari envia Blob anexado como "application/octet-stream" e o backend
    // exige "application/pdf" -> embrulha num File com type explícito.
    const file =
      rec.blob instanceof File && rec.blob.type === 'application/pdf'
        ? rec.blob
        : new File([rec.blob], rec.fileName, { type: 'application/pdf' });
    fd.append('file', file, rec.fileName);
    fd.append('docType', rec.docType);
    fd.append('docDate', rec.docDate);
    fd.append('clientId', rec.clientId);
    if (rec.descricao) fd.append('descricao', rec.descricao);
    let resp;
    try {
      resp = await fetch(API + '/api/documents', { method: 'POST', body: fd });
    } catch (netErr) {
      // falha de rede/DNS/cert -> realmente offline
      const e = new Error('Sem conexão com o servidor.');
      e.offline = true;
      throw e;
    }
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      const e = new Error(j.error || j.detail || 'HTTP ' + resp.status);
      e.server = true;
      e.status = resp.status;
      throw e;
    }
    return resp.json();
  }
  async function recordSent(rec, resp) {
    await SentDocs.add({
      key: (resp && resp.key) || rec.clientId,
      docType: rec.docType,
      docDate: rec.docDate,
      descricao: rec.descricao || '',
      thumb: rec.thumb || '',
      uploadedAt: (resp && resp.uploadedAt) || new Date().toISOString(),
    });
  }

  let syncing = false;
  async function syncPending(manual) {
    if (syncing || !navigator.onLine) {
      if (manual && !navigator.onLine) toast('Sem conexão.', 'err');
      return;
    }
    syncing = true;
    let sent = 0;
    try {
      const items = await PendingQueue.all();
      for (const rec of items) {
        try {
          const resp = await uploadRecord(rec);
          await recordSent(rec, resp);
          await PendingQueue.remove(rec.clientId);
          sent++;
        } catch {
          break; // ainda offline/erro — mantém na lista
        }
      }
    } finally {
      syncing = false;
      await refreshPending();
      if (sent > 0) loadEnviados();
      if (manual) toast(sent ? `${sent} enviado(s).` : 'Nada sincronizado.', sent ? 'ok' : 'err');
    }
  }

  // =======================================================================
  //  CÂMERA (tela cheia) — auto-detecção -> fila de captura (sem editor)
  // =======================================================================
  let stream = null;
  let facingMode = 'environment';
  // Foto still em resolução de FOTO (Android/Chrome). iOS não tem ImageCapture ->
  // continua no frame de vídeo 4K.
  let imageCapture = null;
  let photoCaps = null;

  async function startCamera() {
    if (stream) return;
    try {
      // Pede a maior resolução possível (4K). 'ideal' degrada sozinho se a câmera
      // não suportar. Fonte maior = recorte final maior = documento mais nítido.
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      });
      const v = $('video');
      v.srcObject = stream;
      await v.play();
      // ImageCapture: foto do sensor (12MP+) em vez do frame do preview.
      imageCapture = null;
      photoCaps = null;
      try {
        const track = stream.getVideoTracks()[0];
        if (window.ImageCapture && track) {
          imageCapture = new ImageCapture(track);
          imageCapture
            .getPhotoCapabilities()
            .then((c) => (photoCaps = c))
            .catch(() => (photoCaps = null));
        }
      } catch {
        imageCapture = null;
      }
      $('camHint').textContent = 'Enquadre o documento — captura sozinho ao ficar parado.';
      startLiveDetect();
    } catch (err) {
      $('camHint').textContent =
        'Câmera indisponível. Use o botão de imagem. (' + err.name + ')';
    }
  }
  function stopCamera() {
    stopLiveDetect();
    imageCapture = null;
    photoCaps = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }
  $('switchCamBtn').addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    stopCamera();
    startCamera();
  });
  $('camCloseBtn').addEventListener('click', () => showScreen('home'));
  $('camQueueBtn').addEventListener('click', () => openAnalysis());
  $('filterMode').addEventListener('change', (e) => (currentFilter = e.target.value));

  function frameToCanvas(video) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 1280;
    c.height = video.videoHeight || 960;
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c;
  }

  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  // Foto still do sensor (Android). Devolve canvas ou null (aí fica o frame de vídeo).
  // Cap de 4096 no lado maior p/ não estourar memória em sensores de 48MP+.
  async function takeStillPhoto() {
    if (!imageCapture) return null;
    const opts = [];
    if (photoCaps && photoCaps.imageWidth && photoCaps.imageWidth.max) {
      opts.push({ imageWidth: Math.min(photoCaps.imageWidth.max, 4096) });
    }
    opts.push({}); // sem constraint (alguns aparelhos rejeitam imageWidth)
    for (const opt of opts) {
      try {
        const blob = await withTimeout(imageCapture.takePhoto(opt), 3500);
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        return c;
      } catch {
        /* tenta a próxima opção */
      }
    }
    return null;
  }

  // ---- detecção ao vivo (overlay suave) ----
  let liveTimer = null;
  let liveDraw = null;
  const liveSmall = document.createElement('canvas');
  let lastLiveCorners = null;
  let targetPts = null;
  let drawnPts = null;
  let lastDetAt = 0;
  let overlayProgress = 0;
  const lerp = (a, b, t) => a + (b - a) * t;

  let autoCapture = true;
  let stableSince = 0;
  let prevPts = null;
  let armed = true; // só auto-captura quando "armado" (evita duplicar o mesmo doc)
  const AUTO_CAPTURE_MS = 3000;
  const MOVE_FRAC = 0.03;
  const MIN_AREA_FRAC = 0.22;

  function resetStability() {
    stableSince = 0;
    prevPts = null;
  }
  $('autoToggle').addEventListener('change', (e) => {
    autoCapture = e.target.checked;
    resetStability();
  });

  function startLiveDetect() {
    stopLiveDetect();
    resetStability();
    armed = true;
    liveTimer = setInterval(runLiveDetect, 250);
    liveDraw = setInterval(animateOverlay, 33);
  }
  function stopLiveDetect() {
    if (liveTimer) clearInterval(liveTimer), (liveTimer = null);
    if (liveDraw) clearInterval(liveDraw), (liveDraw = null);
    lastLiveCorners = null;
    targetPts = drawnPts = null;
    overlayProgress = 0;
    resetStability();
    const ov = $('overlay');
    const ctx = ov.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, ov.width, ov.height);
  }

  function polyArea(pts) {
    let a2 = 0;
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % 4];
      a2 += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a2) / 2;
  }
  function detToOverlay(det, sw, sh) {
    const v = $('video');
    const ov = $('overlay');
    const boxW = ov.clientWidth || ov.parentElement.clientWidth;
    const boxH = ov.clientHeight || ov.parentElement.clientHeight;
    const cS = Math.min(boxW / v.videoWidth, boxH / v.videoHeight);
    const cW = v.videoWidth * cS;
    const cH = v.videoHeight * cS;
    const ox = (boxW - cW) / 2;
    const oy = (boxH - cH) / 2;
    return [det.topLeftCorner, det.topRightCorner, det.bottomRightCorner, det.bottomLeftCorner].map(
      (p) => ({ x: ox + (p.x / sw) * cW, y: oy + (p.y / sh) * cH }),
    );
  }

  function runLiveDetect() {
    const video = $('video');
    if (!Scanner.ready || !video.videoWidth || $('screen-camera').hidden) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, 640 / Math.max(vw, vh));
    const sw = Math.round(vw * scale);
    const sh = Math.round(vh * scale);
    liveSmall.width = sw;
    liveSmall.height = sh;
    liveSmall.getContext('2d').drawImage(video, 0, 0, sw, sh);
    const det = Scanner.detectCorners(liveSmall);
    lastLiveCorners = det
      ? {
          topLeftCorner: { x: det.topLeftCorner.x / scale, y: det.topLeftCorner.y / scale },
          topRightCorner: { x: det.topRightCorner.x / scale, y: det.topRightCorner.y / scale },
          bottomRightCorner: { x: det.bottomRightCorner.x / scale, y: det.bottomRightCorner.y / scale },
          bottomLeftCorner: { x: det.bottomLeftCorner.x / scale, y: det.bottomLeftCorner.y / scale },
        }
      : null;

    if (det) {
      const pts = detToOverlay(det, sw, sh);
      targetPts = targetPts
        ? targetPts.map((p, i) => ({ x: lerp(p.x, pts[i].x, 0.5), y: lerp(p.y, pts[i].y, 0.5) }))
        : pts;
      lastDetAt = Date.now();
    } else {
      if (Date.now() - lastDetAt > 500) targetPts = null;
      armed = true; // doc saiu do quadro -> pronto p/ próxima auto-captura
    }

    if (autoCapture && det) {
      const pts = [det.topLeftCorner, det.topRightCorner, det.bottomRightCorner, det.bottomLeftCorner];
      const areaFrac = polyArea(pts) / (sw * sh);
      const diag = Math.hypot(sw, sh);
      let moved = Infinity;
      if (prevPts) {
        moved = 0;
        for (let i = 0; i < 4; i++)
          moved = Math.max(moved, Math.hypot(pts[i].x - prevPts[i].x, pts[i].y - prevPts[i].y));
        moved /= diag;
      }
      prevPts = pts.map((p) => ({ x: p.x, y: p.y }));
      const now = Date.now();
      if (areaFrac >= MIN_AREA_FRAC && moved < MOVE_FRAC) {
        if (!stableSince) stableSince = now;
      } else stableSince = 0;
      overlayProgress = stableSince ? Math.min(1, (now - stableSince) / AUTO_CAPTURE_MS) : 0;
      if (armed && stableSince && now - stableSince >= AUTO_CAPTURE_MS) captureNow(true);
    } else {
      resetStability();
      overlayProgress = 0;
    }
  }

  function animateOverlay() {
    const ov = $('overlay');
    const boxW = ov.clientWidth || ov.parentElement.clientWidth;
    const boxH = ov.clientHeight || ov.parentElement.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const bw = Math.round(boxW * dpr);
    const bh = Math.round(boxH * dpr);
    if (ov.width !== bw) ov.width = bw;
    if (ov.height !== bh) ov.height = bh;
    const ctx = ov.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);
    if (!targetPts) {
      drawnPts = null;
      return;
    }
    drawnPts = drawnPts
      ? drawnPts.map((p, i) => ({ x: lerp(p.x, targetPts[i].x, 0.35), y: lerp(p.y, targetPts[i].y, 0.35) }))
      : targetPts.map((p) => ({ x: p.x, y: p.y }));
    const t = overlayProgress || 0;
    ctx.beginPath();
    ctx.moveTo(drawnPts[0].x, drawnPts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(drawnPts[i].x, drawnPts[i].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(166,206,46,${0.06 + 0.14 * t})`;
    ctx.fill();
    ctx.strokeStyle = '#A6CE2E';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.6 + 1.2 * t;
    ctx.stroke();
    for (const p of drawnPts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5 + 1.5 * t, 0, Math.PI * 2);
      ctx.fillStyle = '#A6CE2E';
      ctx.fill();
    }
  }

  // captura -> fila (NÃO abre editor). auto=true veio da auto-detecção.
  async function captureNow(auto) {
    const video = $('video');
    if (!video.videoWidth) return;
    // base: frame do vídeo (WYSIWYG com o overlay) — sempre disponível
    let frame = frameToCanvas(video);
    let corners = lastLiveCorners || Scanner.detectCorners(frame);
    if (auto) {
      armed = false; // exige o doc sair do quadro p/ a próxima
      resetStability();
    }
    // Upgrade: foto still do sensor (Android). Só troca se for maior que o frame
    // E se conseguirmos cantos confiáveis nela (re-detecção; senão reescala os do
    // vídeo quando o enquadramento bate). Falhou tudo -> mantém o frame de vídeo.
    try {
      const still = await takeStillPhoto();
      if (still && still.width * still.height > frame.width * frame.height) {
        const det = Scanner.detectCorners(still);
        if (det) {
          frame = still;
          corners = det;
        } else if (corners) {
          const arVideo = frame.width / frame.height;
          const arStill = still.width / still.height;
          if (Math.abs(arVideo - arStill) / arVideo < 0.02) {
            // mesmo enquadramento -> reescala os cantos do preview p/ a foto
            const sx = still.width / frame.width;
            const sy = still.height / frame.height;
            const sc = {};
            for (const k of Object.keys(corners))
              sc[k] = { x: corners[k].x * sx, y: corners[k].y * sy };
            frame = still;
            corners = sc;
          }
          // aspecto diferente (FOV da foto ≠ preview): fica no frame de vídeo,
          // senão o recorte reescalado cortaria dados.
        } else {
          frame = still; // sem cantos: melhor a foto inteira em alta resolução
        }
      }
    } catch {
      /* still falhou -> frame de vídeo já está pronto */
    }
    await saveCapture(frame, corners, { silent: true });
    // Animação pós-captura: documento tratado no centro -> linha neon -> voa p/ a fila.
    // Não bloqueia a próxima captura; se o warp falhar, segue sem animar.
    try {
      const cs = cornersForWarp(frame, corners);
      const raw = Scanner.warpToCorners(frame, cs);
      const mode = ($('filterMode') && $('filterMode').value) || currentFilter;
      const fil = Scanner.applyFilter(raw, mode);
      playCaptureFx(raw, fil, $('camQueueBtn'));
    } catch (e) {
      /* sem animação se o recorte falhar */
    }
  }

  async function saveCapture(frameCanvas, corners, opts = {}) {
    const blob = await canvasToBlob(frameCanvas, 0.9);
    const item = {
      id: uuid(),
      blob,
      corners: corners || null,
      thumb: makeThumb(frameCanvas),
      createdAt: Date.now(),
      mode: captureMode, // 'onePdf' | 'perPage'
      session: captureSession, // agrupa as fotos 'onePdf' da mesma sessão
      docType: captureType, // tipo escolhido na home; preenche a análise depois
    };
    await CaptureQueue.add(item);
    await refreshQueueIcon();
    const n = await CaptureQueue.count();
    if (!opts.silent) toast('Documento na fila (' + n + ').', 'ok', 1200);
  }

  // Cantos p/ o warp da animação (fallback = frame inteiro se não houver detecção).
  function cornersForWarp(frame, det) {
    if (det && det.topLeftCorner) return det;
    const w = frame.width;
    const h = frame.height;
    return {
      topLeftCorner: { x: 0, y: 0 },
      topRightCorner: { x: w, y: 0 },
      bottomRightCorner: { x: w, y: h },
      bottomLeftCorner: { x: 0, y: h },
    };
  }

  // Animação de captura estilo CamScanner:
  //  1) flash rápido;
  //  2) o documento aparece no centro e uma linha neon varre de cima p/ baixo,
  //     "revelando" a versão tratada (filtro) por baixo do bruto;
  //  3) o documento encolhe e voa até o ícone da fila (analisar), que pulsa.
  let fxBusy = false;
  function playCaptureFx(rawCanvas, filteredCanvas, targetEl) {
    if (fxBusy) return; // evita empilhar animações em rajada
    fxBusy = true;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ar = rawCanvas.width / Math.max(1, rawCanvas.height);
    let w = vw * 0.62;
    let h = w / ar;
    const maxH = vh * 0.56;
    if (h > maxH) {
      h = maxH;
      w = h * ar;
    }

    const fx = document.createElement('div');
    fx.className = 'cap-fx';
    const flash = document.createElement('div');
    flash.className = 'cap-fx-flash';
    const stage = document.createElement('div');
    stage.className = 'cap-fx-stage';
    stage.style.width = Math.round(w) + 'px';
    stage.style.height = Math.round(h) + 'px';
    const filImg = document.createElement('img'); // tratado (fica por baixo)
    filImg.className = 'cap-fx-img';
    filImg.src = filteredCanvas.toDataURL('image/jpeg', 0.9);
    const rawImg = document.createElement('img'); // bruto (por cima, vai sendo cortado)
    rawImg.className = 'cap-fx-img cap-fx-raw';
    rawImg.src = rawCanvas.toDataURL('image/jpeg', 0.9);
    const line = document.createElement('div');
    line.className = 'cap-fx-line';
    stage.append(filImg, rawImg, line);
    fx.append(flash, stage);
    document.body.append(fx);

    const APPEAR = 200;
    const SWEEP = 780;
    const HOLD = 140;
    const FLY = 460;
    const start = performance.now();

    // Usa setInterval (não requestAnimationFrame): continua rodando mesmo se a aba
    // for throttled, então a animação sempre conclui e nunca deixa fxBusy travado.
    let flew = false;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(timer);
      fx.remove();
      fxBusy = false;
      if (targetEl && !targetEl.hidden) {
        targetEl.classList.remove('queue-pulse');
        void targetEl.offsetWidth; // reinicia a animação do pulso
        targetEl.classList.add('queue-pulse');
        setTimeout(() => targetEl.classList.remove('queue-pulse'), 600);
      }
    };

    function tick() {
      const t = performance.now() - start;
      if (t < APPEAR) {
        const p = t / APPEAR;
        stage.style.transform = 'scale(' + (0.9 + 0.1 * p).toFixed(3) + ')';
        stage.style.opacity = p.toFixed(3);
        flash.style.opacity = (1 - p).toFixed(3);
        line.style.opacity = '0';
        return;
      }
      const st = t - APPEAR;
      if (st < SWEEP) {
        flash.style.opacity = '0';
        stage.style.transform = 'scale(1)';
        stage.style.opacity = '1';
        const p = st / SWEEP;
        rawImg.style.clipPath = 'inset(' + (p * 100).toFixed(2) + '% 0 0 0)';
        line.style.opacity = '1';
        line.style.top = (p * 100).toFixed(2) + '%';
        return;
      }
      if (st < SWEEP + HOLD) {
        rawImg.style.clipPath = 'inset(100% 0 0 0)';
        line.style.opacity = '0';
        return;
      }
      if (!flew) {
        // Fase de voo até o ícone da fila.
        flew = true;
        const rect = targetEl && !targetEl.hidden ? targetEl.getBoundingClientRect() : null;
        const tx = rect ? rect.left + rect.width / 2 - vw / 2 : vw / 2 - 40;
        const ty = rect ? rect.top + rect.height / 2 - vh / 2 : -vh / 2 + 60;
        stage.style.transition =
          'transform ' + FLY + 'ms cubic-bezier(.5,0,.2,1), opacity ' + FLY + 'ms ease-in';
        stage.style.transform =
          'translate(' + tx.toFixed(0) + 'px,' + ty.toFixed(0) + 'px) scale(0.08)';
        stage.style.opacity = '0.15';
        stage.addEventListener('transitionend', cleanup, { once: true });
      }
    }

    const timer = setInterval(tick, 16);
    tick();
    // Watchdog: garante limpeza mesmo sem transitionend / com aba oculta.
    setTimeout(cleanup, APPEAR + SWEEP + HOLD + FLY + 200);
  }

  $('captureBtn').addEventListener('click', () => captureNow(false));
  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = async () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      await saveCapture(c, Scanner.detectCorners(c));
    };
    img.onerror = () => toast('Não foi possível ler a imagem.', 'err');
    img.src = URL.createObjectURL(file);
    e.target.value = '';
  });

  // ---------- OpenCV ----------
  Scanner.loadOpenCV()
    .then(() => ($('cvLoading').hidden = true))
    .catch(() => {
      $('cvLoading').textContent = 'Sem reconhecimento de bordas.';
      setTimeout(() => ($('cvLoading').hidden = true), 4000);
    });

  // =======================================================================
  //  ORGANIZAR + ANÁLISE: agrupa capturas em documentos (multipágina) e envia
  // =======================================================================
  // anGroups: lista de documentos; cada documento é um array de capturas (páginas).
  let anGroups = [];
  let anIndex = 0; // documento atual
  // anPages: páginas do documento atual, já carregadas -> { cap, frame, quad }
  let anPages = [];
  let pageIndex = 0; // página em preview/edição dentro do documento
  let pendingFrame = null; // espelho da página atual (usado pelo editor/preview)
  let quad = null; // espelho dos cantos da página atual
  let editScale = 1;
  let editDpr = 1;
  let dragIndex = -1;
  const HANDLE_HIT = 26;

  // Monta os documentos a partir da fila: fotos 'onePdf' da mesma sessão viram um
  // único documento (multipágina, na ordem); as demais ('perPage' ou antigas) vão sozinhas.
  // O tipo entra na chave junto da sessão: um PDF multipágina nunca mistura
  // documentos de tipos diferentes, mesmo que a fila tenha capturas antigas.
  function groupCaptures(caps) {
    const groups = [];
    const bySession = {};
    for (const c of caps) {
      if (c.mode === 'onePdf' && c.session) {
        const key = c.session + '|' + (c.docType || '');
        if (!bySession[key]) {
          bySession[key] = [];
          groups.push(bySession[key]);
        }
        bySession[key].push(c);
      } else {
        groups.push([c]); // 1 PDF por página
      }
    }
    return groups;
  }

  async function openAnalysis() {
    const caps = await CaptureQueue.all();
    if (caps.length === 0) {
      toast('Nenhum documento na fila.', null, 1500);
      return;
    }
    anGroups = groupCaptures(caps);
    anIndex = 0;
    showScreen('analysis');
    await loadAnGroup();
  }

  let lastFiltered = null; // canvas final (recorte + filtro) reaproveitado no envio
  let quadSnapshot = null; // p/ "Cancelar" no editor

  // Carrega o documento atual (todas as páginas do grupo) para análise.
  async function loadAnGroup() {
    if (anIndex >= anGroups.length) {
      showScreen('home');
      return;
    }
    const group = anGroups[anIndex];
    anPages = [];
    for (const cap of group) {
      const frame = await blobToCanvas(cap.blob);
      const det = cap.corners || Scanner.detectCorners(frame);
      const q = det
        ? clampQuad(cornersFromDetection(det), frame.width, frame.height)
        : defaultQuad(frame.width, frame.height);
      anPages.push({ cap, frame, quad: q });
    }
    $('anProgress').textContent = anIndex + 1 + '/' + anGroups.length;
    $('previewFilter').value = currentFilter;
    $('anDate').value = todayCuiaba();
    $('anDesc').value = '';
    // Tipo já vem da escolha feita na home (segue editável, para corrigir engano).
    const tipoDaCaptura = group[0] && group[0].docType;
    $('anTipo').value = typeOf(tipoDaCaptura) ? tipoDaCaptura : '';
    updateTipoUi();
    showAnState('preview');
    renderPageStrip();
    setActivePage(0);
  }

  // Define a página em edição/preview (sincroniza pendingFrame/quad).
  function setActivePage(i) {
    pageIndex = Math.max(0, Math.min(i, anPages.length - 1));
    pendingFrame = anPages[pageIndex].frame;
    quad = anPages[pageIndex].quad; // mesma referência: edições nos cantos persistem
    renderPreview();
    updatePageStripActive();
    const multi = anPages.length > 1;
    $('anDiscardBtn').textContent = multi ? 'Descartar página' : 'Descartar';
  }

  // Tira de miniaturas das páginas (só aparece com 2+ páginas).
  function renderPageStrip() {
    const strip = $('anPageStrip');
    strip.hidden = anPages.length < 2;
    if (strip.hidden) {
      strip.innerHTML = '';
      return;
    }
    strip.innerHTML = '';
    anPages.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'an-page' + (i === pageIndex ? ' active' : '');
      const im = document.createElement('img');
      im.src = p.cap.thumb || '';
      im.alt = '';
      const num = document.createElement('span');
      num.className = 'an-page-num';
      num.textContent = i + 1;
      b.append(im, num);
      b.addEventListener('click', () => setActivePage(i));
      strip.appendChild(b);
    });
  }
  function updatePageStripActive() {
    const strip = $('anPageStrip');
    [...strip.children].forEach((b, i) => b.classList.toggle('active', i === pageIndex));
  }

  function showAnState(state) {
    $('anPreviewPanel').hidden = state !== 'preview';
    $('anEditPanel').hidden = state !== 'edit';
  }

  // Aplica o recorte (cantos atuais) + filtro e mostra a prévia.
  function renderPreview() {
    const base = Scanner.warpToCorners(pendingFrame, quadToCorners());
    lastFiltered = Scanner.applyFilter(base, $('previewFilter').value);
    const isBw = $('previewFilter').value === 'bw';
    $('anPreviewImg').src = isBw
      ? lastFiltered.toDataURL('image/png')
      : lastFiltered.toDataURL('image/jpeg', 0.92);
  }

  const editorCanvas = () => $('editorCanvas');
  function defaultQuad(w, h) {
    const mx = w * 0.08;
    const my = h * 0.08;
    return [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my }];
  }
  function cornersFromDetection(c) {
    return [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner].map((p) => ({
      x: p.x,
      y: p.y,
    }));
  }
  function clampQuad(q, w, h) {
    return q.map((p) => ({ x: Math.max(0, Math.min(w, p.x)), y: Math.max(0, Math.min(h, p.y)) }));
  }
  function cornersOfQuad(q) {
    return {
      topLeftCorner: q[0],
      topRightCorner: q[1],
      bottomRightCorner: q[2],
      bottomLeftCorner: q[3],
    };
  }
  function quadToCorners() {
    return cornersOfQuad(quad);
  }
  function layoutEditor() {
    const cnv = editorCanvas();
    const wrapW = cnv.parentElement.clientWidth || 320;
    const maxW = Math.max(200, wrapW);
    const maxH = Math.round(window.innerHeight * 0.5);
    const fit = Math.min(maxW / pendingFrame.width, maxH / pendingFrame.height, 1);
    editDpr = Math.min(window.devicePixelRatio || 1, 3);
    editScale = fit * editDpr;
    cnv.width = Math.round(pendingFrame.width * editScale);
    cnv.height = Math.round(pendingFrame.height * editScale);
    cnv.style.width = Math.round(cnv.width / editDpr) + 'px';
    cnv.style.height = Math.round(cnv.height / editDpr) + 'px';
  }
  function drawEditor() {
    const cnv = editorCanvas();
    const ctx = cnv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cnv.width, cnv.height);
    ctx.drawImage(pendingFrame, 0, 0, cnv.width, cnv.height);
    const pts = quad.map((p) => ({ x: p.x * editScale, y: p.y * editScale }));
    const line = 2 * editDpr;
    const r = 10 * editDpr;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cnv.width, cnv.height);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(11,18,32,0.55)';
    ctx.fill('evenodd');
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = '#A6CE2E';
    ctx.lineWidth = line;
    ctx.stroke();
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#A6CE2E';
      ctx.fill();
      ctx.lineWidth = line;
      ctx.strokeStyle = '#0b1220';
      ctx.stroke();
    }
  }
  function evtToCanvas(e) {
    const cnv = editorCanvas();
    const rect = cnv.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (cnv.width / rect.width),
      y: (e.clientY - rect.top) * (cnv.height / rect.height),
    };
  }
  function onPointerDown(e) {
    const pos = evtToCanvas(e);
    let best = -1;
    let bestD = HANDLE_HIT * editDpr;
    quad.forEach((p, i) => {
      const d = Math.hypot(p.x * editScale - pos.x, p.y * editScale - pos.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      dragIndex = best;
      editorCanvas().setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }
  function onPointerMove(e) {
    if (dragIndex < 0) return;
    const pos = evtToCanvas(e);
    quad[dragIndex] = {
      x: Math.max(0, Math.min(pendingFrame.width, pos.x / editScale)),
      y: Math.max(0, Math.min(pendingFrame.height, pos.y / editScale)),
    };
    drawEditor();
    e.preventDefault();
  }
  function onPointerUp(e) {
    if (dragIndex >= 0) {
      try {
        editorCanvas().releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    }
    dragIndex = -1;
  }
  const ec = editorCanvas();
  ec.addEventListener('pointerdown', onPointerDown);
  ec.addEventListener('pointermove', onPointerMove);
  ec.addEventListener('pointerup', onPointerUp);
  ec.addEventListener('pointercancel', onPointerUp);

  // filtro na prévia: aplica na hora
  $('previewFilter').addEventListener('change', (e) => {
    currentFilter = e.target.value;
    renderPreview();
  });

  // Grava o quad atual na página em edição (handlers abaixo reatribuem `quad`,
  // então precisamos re-apontar a página para o array novo).
  function commitQuad() {
    if (anPages[pageIndex]) anPages[pageIndex].quad = quad;
  }

  // abrir/editar os pontos
  $('anEditBtn').addEventListener('click', () => {
    quadSnapshot = quad.map((p) => ({ x: p.x, y: p.y }));
    showAnState('edit');
    layoutEditor();
    drawEditor();
  });
  $('anEditApplyBtn').addEventListener('click', () => {
    commitQuad();
    showAnState('preview');
    renderPreview();
  });
  $('anEditCancelBtn').addEventListener('click', () => {
    if (quadSnapshot) quad = quadSnapshot; // desfaz os ajustes
    commitQuad();
    showAnState('preview');
  });
  $('detectBtn').addEventListener('click', () => {
    const det = Scanner.detectCorners(pendingFrame);
    if (det) {
      quad = clampQuad(cornersFromDetection(det), pendingFrame.width, pendingFrame.height);
      commitQuad();
      drawEditor();
      toast('Bordas detectadas.', 'ok', 1000);
    } else toast('Não detectei — ajuste os cantos.', 'err', 2000);
  });
  $('selectAllBtn').addEventListener('click', () => {
    quad = [
      { x: 0, y: 0 },
      { x: pendingFrame.width, y: 0 },
      { x: pendingFrame.width, y: pendingFrame.height },
      { x: 0, y: pendingFrame.height },
    ];
    commitQuad();
    drawEditor();
  });

  $('anCloseBtn').addEventListener('click', () => showScreen('home'));
  // Descarta a PÁGINA atual do documento; se era a última, passa ao próximo documento.
  $('anDiscardBtn').addEventListener('click', async () => {
    const page = anPages[pageIndex];
    if (!page) return;
    await CaptureQueue.remove(page.cap.id);
    anPages.splice(pageIndex, 1);
    anGroups[anIndex] = anGroups[anIndex].filter((c) => c.id !== page.cap.id);
    await refreshQueueIcon();
    if (anPages.length === 0) {
      anGroups.splice(anIndex, 1); // documento ficou vazio
      toast('Descartado.', null, 1000);
      await loadAnGroup();
    } else {
      toast('Página descartada.', null, 1000);
      renderPageStrip();
      setActivePage(Math.min(pageIndex, anPages.length - 1));
    }
  });

  // =======================================================================
  //  TIPO DO DOCUMENTO (na análise)
  // =======================================================================
  // O tipo já chega escolhido da home. Aqui só ajustamos o texto de exemplo da
  // descrição para o vocabulário de cada tipo do SAC.
  const DESC_PLACEHOLDER = {
    'nota-fiscal': 'Ex.: pedido 1234, cliente…',
    'cupom-fiscal': 'Ex.: venda balcão, caixa 2…',
    ni: 'Ex.: conferência, remessa…',
    'nota-devolucao': 'Ex.: nota de origem, motivo…',
    'ni-devolucao': 'Ex.: motivo da devolução…',
    'ni-garantia': 'Ex.: peça, nº de série…',
  };
  function updateTipoUi() {
    $('anDesc').placeholder = DESC_PLACEHOLDER[$('anTipo').value] || 'Ex.: pedido, cliente…';
  }
  $('anTipo').addEventListener('change', updateTipoUi);

  const esc = (s) =>
    String(s == null ? '' : s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  const dataBr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

  // Texto livre -> pedaço seguro de nome de arquivo: sem acento, sem espaço, sem
  // caractere que o Windows/MinIO recusem. Mesma regra do slugify do backend.
  // Corta em 60 p/ a descrição não dominar o nome (o campo aceita até 120).
  function slugify(s, max = 60) {
    const out = String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // marcas de acento soltas pelo NFD
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .slice(0, max);
    return out.replace(/_+$/, ''); // o corte pode ter deixado "_" solto no fim
  }

  // ---- PDF (1 página) ----
  const PDF_MAX_SIDE = 3500;
  function toJpegDataUrl(cnv, q) {
    const longest = Math.max(cnv.width, cnv.height);
    let src = cnv;
    if (longest > PDF_MAX_SIDE) {
      const s = PDF_MAX_SIDE / longest;
      const t = document.createElement('canvas');
      t.width = Math.max(1, Math.round(cnv.width * s));
      t.height = Math.max(1, Math.round(cnv.height * s));
      t.getContext('2d').drawImage(cnv, 0, 0, t.width, t.height);
      src = t;
    }
    const data = src.toDataURL('image/jpeg', q);
    if (!data || data.length < 100 || data.indexOf('data:image/jpeg') !== 0)
      throw new Error('Falha ao gerar imagem do PDF.');
    return data;
  }
  // PDF com 1..N páginas (uma imagem por página, centralizada em A4).
  function buildPdfPages(canvases) {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    canvases.forEach((canvas, i) => {
      if (i > 0) pdf.addPage();
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const margin = 18;
      const ratio = Math.min((pw - margin * 2) / canvas.width, (ph - margin * 2) / canvas.height);
      const w = canvas.width * ratio;
      const h = canvas.height * ratio;
      pdf.addImage(toJpegDataUrl(canvas, 0.95), 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h);
    });
    return pdf.output('blob');
  }

  $('anConfirmBtn').addEventListener('click', async () => {
    if (!anPages.length) return; // nada p/ confirmar
    const docType = $('anTipo').value;
    const docDate = $('anDate').value;
    if (!docType) return toast('Selecione o tipo.', 'err');
    if (!docDate) return toast('Informe a data.', 'err');
    const descricao = $('anDesc').value.trim();
    const filter = $('previewFilter').value;
    const btn = $('anConfirmBtn');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      // renderiza TODAS as páginas do documento com o mesmo recorte + filtro
      const canvases = anPages.map((p) =>
        Scanner.applyFilter(Scanner.warpToCorners(p.frame, cornersOfQuad(p.quad)), filter),
      );
      const nPag = canvases.length;
      const blob = buildPdfPages(canvases);
      const clientId = uuid();
      const rec = {
        clientId,
        blob,
        docType,
        docDate,
        descricao,
        thumb: makeThumb(canvases[0]),
        // A descrição entra no nome p/ achar o PDF pelo nome depois (na exportação
        // em lote e no download avulso, onde só o nome do arquivo aparece).
        fileName:
          [docDate, docType, slugify(descricao), nPag > 1 ? `${nPag}p` : '']
            .filter(Boolean)
            .join('_') + '.pdf',
        createdAt: Date.now(),
      };
      currentFilter = filter;
      try {
        const resp = await uploadRecord(rec);
        await recordSent(rec, resp);
        toast(nPag > 1 ? `Enviado (${nPag} páginas).` : 'Enviado.', 'ok', 1200);
      } catch (err) {
        await PendingQueue.add(rec);
        if (err.server)
          toast('Servidor recusou: ' + err.message + ' (ficou em pendentes)', 'err', 4500);
        else toast('Sem conexão — foi para pendentes.', 'err', 2600);
      }
      // remove todas as páginas do documento da fila de captura
      for (const p of anPages) await CaptureQueue.remove(p.cap.id);
      await refreshQueueIcon();
      anGroups.splice(anIndex, 1); // documento enviado sai da lista
      await loadAnGroup();
    } catch (err) {
      toast('Falha: ' + err.message, 'err', 3000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirmar e enviar';
    }
  });

  // ---------- tipos nos <select> ----------
  // A lista TYPES é a fonte da verdade do app (não vem mais de /api/config):
  // são os tipos do SAC e precisam bater com o que o backend aceita em docType.
  function fillTypeSelects() {
    const an = $('anTipo');
    an.appendChild(new Option('Selecione…', ''));
    TYPES.forEach((t) => {
      an.appendChild(new Option(t.label, t.id));
      $('fTipo').appendChild(new Option(t.label, t.id));
    });
  }

  // ---------- init ----------
  function init() {
    updateNet();
    fillTypeSelects();
    renderTypeGrid();
    showScreen('home');
  }
  init();
})();
