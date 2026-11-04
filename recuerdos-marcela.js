(() => {
  'use strict';

  const CONFIG = window.MARCELA_RECUERDOS_CONFIG;
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = {
    queue: [], memories: [], page: 1,
    loading: false, hasMore: true, galleryError: false, pendingGalleryReset: false,
    galleryObserver: null, galleryScrollFallback: null, running: false,
    active: null, opener: null, swipeStartX: null
  };
  const fileTypes = {
    jpg: ['photo', 'image/jpeg'], jpeg: ['photo', 'image/jpeg'],
    png: ['photo', 'image/png'], webp: ['photo', 'image/webp'],
    heic: ['photo', 'image/heic'], heif: ['photo', 'image/heif'],
    mp4: ['video', 'video/mp4'], mov: ['video', 'video/quicktime'],
    webm: ['video', 'video/webm']
  };

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    if (!$('#uploadList')) return;
    $('#photoButton').addEventListener('click', () => $('#photoInput').click());
    $('#videoButton').addEventListener('click', () => $('#videoInput').click());
    $('#takePhotoButton').addEventListener('click', () => $('#cameraPhotoInput').click());
    for (const [selector, kind] of [['#photoInput', 'photo'], ['#videoInput', 'video'], ['#cameraPhotoInput', 'photo']]) {
      $(selector).addEventListener('change', (event) => {
        addFiles(event.currentTarget.files, kind);
        event.currentTarget.value = '';
      });
    }
    $('#uploadAllButton').addEventListener('click', () => {
      for (const item of state.queue) {
        if (item.status === 'error' || item.status === 'cancelled') item.status = 'pending';
      }
      runQueue();
    });
    $('#refreshGallery').addEventListener('click', () => loadMemories(true));
    $('#memoriesGallery').addEventListener('click', (event) => {
      const card = event.target.closest('[data-memory-id]');
      if (card) openMemory(card.dataset.memoryId, card);
    });
    bindDropZone();
    bindGalleryInfiniteScroll();
    bindLightbox();
    if (CONFIG) {
      $('#fileFormats').replaceChildren(
        element('span', 'moments-formats__group', 'Fotos (JPG/JPEG, PNG, WebP, HEIC y HEIF): máximo ' + formatBytes(CONFIG.maxPhotoInputSize) + ' por archivo; se guardan optimizadas en WebP (máximo ' + formatBytes(CONFIG.maxPhotoProcessedSize) + ').'),
        element('span', 'moments-formats__group', 'Videos (MP4, MOV y WebM): máximo ' + formatBytes(CONFIG.maxVideoSize) + ' por archivo.')
      );
    }
    window.addEventListener('beforeunload', (event) => {
      if (!state.running) return;
      event.preventDefault();
      event.returnValue = '';
    });
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      state.galleryObserver?.disconnect();
      if (state.galleryScrollFallback) {
        window.removeEventListener('scroll', state.galleryScrollFallback);
        window.removeEventListener('resize', state.galleryScrollFallback);
      }
      for (const item of state.queue) {
        item.xhr?.abort();
        URL.revokeObjectURL(item.previewUrl);
      }
    });
    loadMemories(true);
  }

  function bindDropZone() {
    const zone = $('#uploadDropZone');
    zone.addEventListener('dragover', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      zone.classList.add('is-dragging');
    });
    zone.addEventListener('dragleave', (event) => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-dragging');
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('is-dragging');
      if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
    });
    // Dropping a file outside the queue must not navigate away from the album.
    document.addEventListener('dragover', (event) => {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
      if (event.dataTransfer?.files?.length) event.preventDefault();
    });
  }

  function addFiles(files, expectedKind) {
    const errors = [];
    let added = 0;
    for (const file of Array.from(files || [])) {
      const result = validateFile(file, expectedKind);
      if (!result.ok) {
        errors.push(file.name + ': ' + result.message);
        continue;
      }
      if (state.queue.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) {
        errors.push(file.name + ' ya está en la cola.');
        continue;
      }
      const item = {
        id: createId(), file, kind: result.kind, mime: result.mime,
        status: 'pending', progress: 0, message: 'Listo para compartir.',
        previewUrl: URL.createObjectURL(file), cancelled: false,
        artifacts: null, record: null, uploaded: new Set(), xhr: null,
        uploadToken: crypto.randomUUID() + crypto.randomUUID()
      };
      item.element = createUploadItem(item);
      state.queue.push(item);
      $('#uploadList').append(item.element);
      added += 1;
    }
    let message = added ? added + (added === 1 ? ' recuerdo listo para revisar.' : ' recuerdos listos para revisar.') : '';
    if (errors.length) message += (message ? ' ' : '') + errors.join(' ');
    setFeedback('#selectionStatus', message, errors.length ? 'error' : '');
    updateQueue();
    if (added) $('#subidas').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }

  function validateFile(file, expectedKind) {
    const info = fileTypes[getExtension(file.name)];
    if (!info || (expectedKind && info[0] !== expectedKind)) {
      return { ok: false, message: expectedKind === 'video'
        ? 'Selecciona un video compatible.'
        : expectedKind === 'photo' ? 'Selecciona una fotografía compatible.' : 'Este formato no es compatible.' };
    }
    const [kind, mime] = info;
    const acceptedMimes = Object.values(fileTypes).filter((entry) => entry[0] === kind).map((entry) => entry[1]);
    if (file.type && !acceptedMimes.includes(file.type)) return { ok: false, message: 'El contenido no coincide con un formato admitido.' };
    if (!file.size) return { ok: false, message: 'El archivo está vacío.' };
    const limit = kind === 'photo' ? CONFIG?.maxPhotoInputSize : CONFIG?.maxVideoSize;
    if (!limit) return { ok: false, message: 'No se pudo cargar la configuración del álbum.' };
    if (file.size > limit) return { ok: false, message: kind === 'photo'
        ? 'La fotografía no puede superar 50 MB por archivo.' : 'El video no puede superar 250 MB por archivo.' };
    return { ok: true, kind, mime: file.type || mime };
  }

  function createUploadItem(item) {
    const li = element('li', 'moments-upload-item');
    li.dataset.state = item.status;
    const preview = element('div', 'moments-upload-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.append(icon(item.kind === 'photo' ? 'photos' : 'play'));
    const media = document.createElement(item.kind === 'photo' ? 'img' : 'video');
    if (item.kind === 'photo') media.alt = '';
    else {
      media.muted = true;
      media.playsInline = true;
      media.preload = 'metadata';
    }
    media.src = item.previewUrl;
    media.addEventListener('error', () => media.remove(), { once: true });
    preview.prepend(media);
    const info = element('div', 'moments-upload-info');
    info.append(element('span', 'moments-upload-name', item.file.name));
    info.append(element('p', 'moments-upload-meta', (item.kind === 'photo' ? 'Fotografía' : 'Video') + ' · ' + formatBytes(item.file.size)));
    const status = element('p', 'moments-upload-status', item.message);
    status.setAttribute('role', 'status');
    const progress = element('progress', 'moments-upload-progress');
    progress.max = 100;
    progress.value = 0;
    progress.hidden = true;
    progress.setAttribute('aria-label', 'Progreso de ' + item.file.name);
    info.append(status, progress);
    const controls = element('div', 'moments-upload-controls');
    const retry = element('button', 'moments-text-button', 'Reintentar');
    retry.type = 'button';
    retry.hidden = true;
    retry.setAttribute('aria-label', 'Reintentar ' + item.file.name);
    retry.addEventListener('click', () => {
      if (isActive(item)) return;
      item.status = 'pending';
      item.cancelled = false;
      renderUploadItem(item);
      runQueue();
    });
    const remove = element('button', 'moments-icon-button moments-icon-button--plain');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Quitar ' + item.file.name + ' de la cola');
    remove.append(icon('close'));
    remove.addEventListener('click', () => {
      if (item.committing) return;
      if (isActive(item)) {
        item.cancelled = true;
        item.xhr?.abort();
        setUploadState(item, 'cancelled', 'Subida cancelada.', item.progress);
      } else {
        releaseMedia(item.element);
        URL.revokeObjectURL(item.previewUrl);
        state.queue = state.queue.filter((entry) => entry !== item);
        item.element.remove();
        updateQueue();
      }
    });
    controls.append(retry, remove);
    li.append(preview, info, controls);
    return li;
  }

  function renderUploadItem(item) {
    item.element.dataset.state = item.status;
    $('.moments-upload-status', item.element).textContent = item.message;
    const progress = $('progress', item.element);
    progress.value = item.progress;
    progress.hidden = item.status === 'pending';
    const retry = $('.moments-text-button', item.element);
    retry.hidden = !['error', 'cancelled'].includes(item.status);
    retry.disabled = state.running;
    const remove = $('.moments-icon-button', item.element);
    remove.disabled = Boolean(item.committing);
    remove.setAttribute('aria-label', (isActive(item) ? 'Cancelar la subida de ' : 'Quitar de la cola: ') + item.file.name);
  }

  function updateQueue() {
    $('#queueEmpty').hidden = state.queue.length > 0;
    $('#queueFooter').hidden = state.queue.length === 0;
    $('#queueCount').textContent = state.queue.length + (state.queue.length === 1 ? ' archivo' : ' archivos');
    const done = state.queue.filter((item) => item.status === 'done').length;
    const errors = state.queue.filter((item) => item.status === 'error').length;
    const waiting = state.queue.filter((item) => ['pending', 'error', 'cancelled'].includes(item.status)).length;
    const button = $('#uploadAllButton');
    button.disabled = state.running || !waiting;
    button.setAttribute('aria-busy', String(state.running));
    $('span', button).textContent = state.running ? 'Compartiendo…' : errors ? 'Reintentar pendientes'
      : done && done === state.queue.length ? 'Recuerdos compartidos' : 'Subir recuerdos';
    $('#queueSummary').textContent = state.running
      ? 'Compartiendo tus recuerdos. Mantén esta página abierta.'
      : done ? done + ' de ' + state.queue.length + ' compartidos.' + (errors ? ' Puedes reintentar los que fallaron.' : '')
      : 'Revisa tus archivos y pulsa «Subir recuerdos».';
    if (done && done === state.queue.length && $('#selectionStatus').dataset.state !== 'error') {
      setFeedback('#selectionStatus', '', '');
    }
    for (const item of state.queue) renderUploadItem(item);
  }

  async function runQueue() {
    if (state.running || !state.queue.some((item) => item.status === 'pending')) return;
    if (!hasConnectionConfig()) {
      setFeedback('#selectionStatus', 'Falta configurar la conexión del álbum.', 'error');
      return;
    }
    state.running = true;
    updateQueue();
    let uploaded = false;
    try {
      let item;
      while ((item = state.queue.find((entry) => entry.status === 'pending'))) {
        item.cancelled = false;
        await uploadMemory(item);
        uploaded = uploaded || item.status === 'done';
      }
    } finally {
      state.running = false;
      updateQueue();
      if (uploaded) loadMemories(true);
    }
  }

  async function uploadMemory(item) {
    try {
      setUploadState(item, 'processing', 'Preparando tu recuerdo…', 2);
      if (!item.artifacts) await prepareMemory(item);
      checkCancelled(item);
      item.uploadPrepared = true;
      const prepared = await apiRequest('/api/events/marcela-98/uploads', {
        method: 'POST',
        headers: { ...authHeaders(item), 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: item.record, files: item.artifacts.map(artifact => ({
          path: artifact.path, size: artifact.body.size, mime_type: artifact.mime || artifact.body.type
        })) })
      });
      if (prepared?.status === 'committed') {
        setUploadState(item, 'done', '¡Ya forma parte de nuestros recuerdos!', 100);
        item.artifacts = null;
        item.uploadPrepared = false;
        return;
      }
      checkCancelled(item);
      const count = item.artifacts.length;
      for (let index = 0; index < count; index += 1) {
        const artifact = item.artifacts[index];
        checkCancelled(item);
        if (item.uploaded.has(artifact.path)) continue;
        setUploadState(item, 'uploading', artifact.label, 8 + index / count * 86);
        await uploadToStorage(item, artifact, (percent) => {
          setUploadState(item, 'uploading', artifact.label + ' ' + percent + '%',
            8 + (index + percent / 100) / count * 86);
        });
        item.uploaded.add(artifact.path);
      }
      checkCancelled(item);
      setUploadState(item, 'uploading', 'Guardando tu recuerdo en el álbum…', 96);
      item.committing = true;
      renderUploadItem(item);
      // A retry after a lost response must not create another album entry.
      await apiRequest('/api/events/marcela-98/memories', {
        method: 'POST',
        headers: { ...authHeaders(item), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id })
      });
      setUploadState(item, 'done', '¡Ya forma parte de nuestros recuerdos!', 100);
      // Upload metadata is committed: release the large derivative buffers.
      item.artifacts = null;
      item.uploadPrepared = false;
    } catch (error) {
      if (item.uploadPrepared) {
        await apiRequest('/api/events/marcela-98/uploads/' + encodeURIComponent(item.id), {
          method: 'DELETE', headers: authHeaders(item)
        }).catch(() => {});
        item.uploadPrepared = false;
        item.uploaded.clear();
      }
      if (item.cancelled || error.name === 'AbortError') {
        setUploadState(item, 'cancelled', 'Subida cancelada. Puedes reintentarlo.', item.progress);
      } else {
        setUploadState(item, 'error', friendlyError(error, 'No pudimos subir este recuerdo. Inténtalo de nuevo.', item.kind), item.progress);
      }
    } finally {
      item.xhr = null;
      item.committing = false;
      renderUploadItem(item);
    }
  }

  async function prepareMemory(item) {
    const paths = CONFIG.paths;
    const artifacts = [];
    const record = {
      id: item.id, original_name: item.file.name, media_type: item.kind,
      original_path: '', optimized_path: null, thumbnail_path: null,
      mime_type: item.mime, file_size: item.file.size,
      width: null, height: null, duration: null
    };
    if (item.kind === 'photo') {
      checkCancelled(item);
      const derivative = await createPhotoDerivative(
        item.file, CONFIG.optimizedMaxDimension, CONFIG.webpQuality, CONFIG.maxPhotoProcessedSize
      );
      record.original_path = paths.photos + '/' + item.id + '.webp';
      record.mime_type = derivative.blob.type;
      record.file_size = derivative.blob.size;
      record.width = derivative.width;
      record.height = derivative.height;
      artifacts.push({ path: record.original_path, body: derivative.blob, label: 'Guardando la foto optimizada…' });
    } else {
      record.original_path = paths.originalsVideos + '/' + item.id + '.' + getExtension(item.file.name);
      artifacts.push({ path: record.original_path, body: item.file, mime: item.mime, label: 'Guardando el video…' });
      const poster = await createVideoPoster(item.file);
      checkCancelled(item);
      if (poster) {
        const path = paths.thumbnailsVideos + '/' + item.id + '.webp';
        artifacts.push({ path, body: poster.blob, label: 'Guardando la portada del video…' });
        record.thumbnail_path = path;
        record.width = poster.width;
        record.height = poster.height;
        record.duration = poster.duration;
      }
    }
    item.artifacts = artifacts;
    item.record = record;
  }

  async function createPhotoDerivative(file, maxDimension, quality, maxBytes = CONFIG.maxPhotoProcessedSize) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      let dimension = Math.min(maxDimension, Math.max(bitmap.width, bitmap.height));
      const qualities = [quality, .76, .7, .64, .58, .52];
      for (let resizePass = 0; resizePass < 7; resizePass += 1) {
        const scale = Math.min(1, dimension / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No se pudo preparar la foto.');
        context.drawImage(bitmap, 0, 0, width, height);
        for (const encodeQuality of qualities) {
          const blob = await canvasToBlob(canvas, encodeQuality);
          if (blob.size <= maxBytes) return { blob, width, height };
        }
        dimension = Math.max(360, Math.floor(dimension * .82));
      }
      throw new Error('La fotografía no puede superar 50 MB por archivo.');
    } catch (error) {
      if (error.message === 'La fotografía no puede superar 50 MB por archivo.') throw error;
      throw new Error(/\.(heic|heif)$/i.test(file.name)
        ? 'Este navegador no pudo abrir HEIC/HEIF. Guarda una copia como JPG y vuelve a seleccionarla.'
        : 'No se pudo procesar la foto. Comprueba que el archivo se abre correctamente.');
    } finally {
      bitmap?.close?.();
    }
  }

  function createVideoPoster(file) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(file);
      let finished = false;
      let frameTimes = [];
      let frameIndex = 0;
      const finish = (poster) => {
        if (finished) return;
        finished = true;
        releaseVideo();
        resolve(poster);
      };
      const finishWithFallback = async () => {
        if (finished) return;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
        finished = true;
        releaseVideo();
        try {
          const blob = await createFallbackVideoPoster();
          resolve({ blob, width: 480, height: 360, duration });
        } catch { resolve(null); }
      };
      const releaseVideo = () => {
        clearTimeout(timer);
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
      };
      const timer = setTimeout(finishWithFallback, 15000);
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.addEventListener('loadedmetadata', () => {
        if (!video.videoWidth || !Number.isFinite(video.duration) || video.duration <= 0) return finishWithFallback();
        frameTimes = [video.duration * .1, video.duration * .25, video.duration * .5, video.duration * .75]
          .filter((time, index, values) => time > 0 && time < video.duration && values.indexOf(time) === index);
        seekNextVideoPosterFrame();
      }, { once: true });
      video.addEventListener('seeked', async () => {
        try {
          const scale = Math.min(1, CONFIG.thumbnailMaxDimension / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext('2d');
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (isNearlyBlackFrame(context)) {
            if (frameIndex < frameTimes.length) {
              seekNextVideoPosterFrame();
              return;
            }
            finishWithFallback();
            return;
          }
          const blob = await canvasToBlob(canvas, CONFIG.thumbnailQuality);
          finish({ blob, width: video.videoWidth, height: video.videoHeight, duration: video.duration });
        } catch { finishWithFallback(); }
      });
      video.addEventListener('error', finishWithFallback, { once: true });
      video.src = url;

      function seekNextVideoPosterFrame() {
        if (frameIndex >= frameTimes.length) return finishWithFallback();
        try { video.currentTime = frameTimes[frameIndex++]; }
        catch { finishWithFallback(); }
      }
    });
  }

  function createFallbackVideoPoster() {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    if (!context) return Promise.reject(new Error('No se pudo crear la portada del video.'));
    const background = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    background.addColorStop(0, '#5b1932');
    background.addColorStop(1, '#27101c');
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#efc58a';
    context.lineWidth = 5;
    context.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);
    context.strokeStyle = 'rgba(255, 243, 224, .7)';
    context.lineWidth = 1;
    context.strokeRect(25, 25, canvas.width - 50, canvas.height - 50);
    context.beginPath();
    context.arc(canvas.width / 2, 142, 50, 0, Math.PI * 2);
    context.fillStyle = 'rgba(239, 197, 138, .18)';
    context.fill();
    context.beginPath();
    context.moveTo(254, 142);
    context.lineTo(234, 129);
    context.lineTo(234, 155);
    context.closePath();
    context.fillStyle = '#fff3e0';
    context.fill();
    context.textAlign = 'center';
    context.fillStyle = '#fff3e0';
    context.font = '600 22px Georgia, serif';
    context.fillText('VIDEO DE MARCELA', canvas.width / 2, 248);
    context.fillStyle = '#efc58a';
    context.font = '14px Georgia, serif';
    context.fillText('Un recuerdo compartido', canvas.width / 2, 277);
    return canvasToBlob(canvas, .84);
  }

  function isNearlyBlackFrame(context) {
    const sample = document.createElement('canvas');
    sample.width = 32;
    sample.height = 32;
    const sampleContext = sample.getContext('2d', { willReadFrequently: true });
    sampleContext.drawImage(context.canvas, 0, 0, sample.width, sample.height);
    const pixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data;
    let luminance = 0;
    let visiblePixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const value = .2126 * pixels[index] + .7152 * pixels[index + 1] + .0722 * pixels[index + 2];
      luminance += value;
      if (value > 20) visiblePixels += 1;
    }
    const count = pixels.length / 4;
    return luminance / count < 14 && visiblePixels / count < .08;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('No se pudo preparar la imagen.')), 'image/webp', quality);
    });
  }

  function uploadToStorage(item, artifact, onProgress) {
    const body = artifact.body;
    if ((artifact.mime || body.type || '').startsWith('video/') && body.size > 8 * 1024 * 1024) {
      return uploadVideoInParts(item, artifact, onProgress);
    }
    return uploadBlob(item, artifact, body, {}, onProgress);
  }

  async function uploadVideoInParts(item, artifact, onProgress) {
    const chunkSize = 8 * 1024 * 1024;
    const body = artifact.body;
    const partCount = Math.ceil(body.size / chunkSize);
    for (let index = 0; index < partCount; index += 1) {
      checkCancelled(item);
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, body.size);
      const part = body.slice(start, end, artifact.mime || body.type);
      await uploadBlob(item, artifact, part, {
        'X-Upload-Part-Number': String(index + 1),
        'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + body.size
      }, (percent) => onProgress(Math.round((start + part.size * percent / 100) / body.size * 100)));
    }
  }

  function uploadBlob(item, artifact, body, extraHeaders, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      xhr.open('PUT', baseUrl() + '/api/events/marcela-98/objects/' + encodePath(artifact.path));
      for (const [name, value] of Object.entries({ ...authHeaders(item), ...extraHeaders })) xhr.setRequestHeader(name, value);
      xhr.setRequestHeader('Content-Type', artifact.mime || artifact.body.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Upload-Id', item.id);
      // Allow larger videos time to finish on mobile connections.
      xhr.timeout = 900000;
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
      });
      xhr.addEventListener('load', async () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let payload = {};
        try { payload = JSON.parse(xhr.responseText) || {}; } catch { /* Keep the friendly fallback. */ }
        const error = new Error(payload.message || 'No se pudo guardar el archivo.');
        error.status = xhr.status;
        error.code = payload.code;
        reject(error);
      });
      xhr.addEventListener('error', () => reject(new Error('No pudimos conectar con el álbum. Inténtalo nuevamente.')));
      xhr.addEventListener('timeout', () => reject(new Error('No pudimos conectar con el álbum. Inténtalo nuevamente.')));
      xhr.addEventListener('abort', () => reject(new DOMException('Subida cancelada.', 'AbortError')));
      if (item.cancelled) return reject(new DOMException('Subida cancelada.', 'AbortError'));
      xhr.send(body);
    });
  }

  async function apiRequest(path, options = {}) {
    if (!hasConnectionConfig()) throw new Error('Falta configurar la conexión del álbum.');
    let response;
    try {
      response = await fetch(baseUrl() + path, {
        ...options, signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new Error('No pudimos conectar con el álbum. Inténtalo nuevamente.');
    }
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json() || {}; } catch { /* Do not expose raw backend responses. */ }
      const error = new Error(payload.message || 'El álbum no pudo completar la solicitud.');
      error.status = response.status;
      error.code = payload.code;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  function authHeaders(item) {
    return { Authorization: 'Bearer ' + item.uploadToken };
  }

  function galleryBatchSize() {
    return CONFIG?.pageSize || 10;
  }

  function bindGalleryInfiniteScroll() {
    const sentinel = $('#gallerySentinel');
    if ('IntersectionObserver' in window) {
      state.galleryObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMemories(false);
      }, { rootMargin: '180px 0px' });
      state.galleryObserver.observe(sentinel);
      return;
    }
    state.galleryScrollFallback = () => {
      if (sentinel.getBoundingClientRect().top <= window.innerHeight + 180) loadMemories(false);
    };
    window.addEventListener('scroll', state.galleryScrollFallback, { passive: true });
    window.addEventListener('resize', state.galleryScrollFallback);
  }

  async function loadMemories(reset = false) {
    if (state.loading) {
      if (reset) state.pendingGalleryReset = true;
      return;
    }
    if (!reset && (!state.hasMore || state.galleryError)) return;
    const requestedPage = reset ? 1 : state.page;
    state.loading = true;
    const refresh = $('#refreshGallery');
    refresh.disabled = true;
    refresh.setAttribute('aria-busy', 'true');
    $('#memoriesGallery').setAttribute('aria-busy', 'true');
    setFeedback('#galleryStatus', state.memories.length && !reset ? 'Cargando más recuerdos…' : 'Buscando recuerdos…', '');
    $('#galleryEmpty').hidden = true;
    try {
      if (!hasConnectionConfig()) throw new Error('Falta configurar la conexión del álbum.');
      const result = await apiRequest('/api/events/marcela-98/memories?' + new URLSearchParams({ page: String(requestedPage) }));
      if (!Array.isArray(result.data) || !Number.isSafeInteger(result.total) || result.total < 0
        || !Number.isSafeInteger(result.page) || result.page < 1 || result.pageSize !== galleryBatchSize()) {
        throw new Error('El álbum devolvió una respuesta inesperada.');
      }
      if (state.pendingGalleryReset && !reset) return;
      const incoming = result.data.filter(isEventRecord).map(mapRecord);
      const existingIds = new Set(reset ? [] : state.memories.map((memory) => memory.id));
      const newMemories = incoming.filter((memory) => !existingIds.has(memory.id));
      if (reset) {
        state.memories = incoming;
        $('#memoriesGallery').replaceChildren(...incoming.map(createMemoryCard));
      } else {
        state.memories.push(...newMemories);
        $('#memoriesGallery').append(...newMemories.map(createMemoryCard));
      }
      state.page = result.page + 1;
      state.hasMore = result.page < Math.ceil(result.total / result.pageSize);
      state.galleryError = false;
      $('#galleryEmpty').hidden = state.memories.length > 0;
      setFeedback('#galleryStatus', '', '');
    } catch (error) {
      state.galleryError = true;
      setFeedback('#galleryStatus', friendlyError(error, 'No se pudo cargar la galería. Pulsa «Actualizar» para reintentar.'), 'error');
    } finally {
      state.loading = false;
      refresh.disabled = false;
      refresh.setAttribute('aria-busy', 'false');
      $('#memoriesGallery').setAttribute('aria-busy', 'false');
      if (state.pendingGalleryReset) {
        state.pendingGalleryReset = false;
        loadMemories(true);
      } else {
        state.galleryScrollFallback?.();
      }
    }
  }

  function isEventRecord(record) {
    const prefix = record.media_type === 'photo' ? CONFIG.paths.photos : CONFIG.paths.originalsVideos;
    return record.id && ['photo', 'video'].includes(record.media_type) && record.original_path?.startsWith(prefix + '/');
  }

  function mapRecord(record) {
    const thumbnailPath = record.thumbnail_path || (record.media_type === 'photo' ? record.optimized_path || record.original_path : '');
    const thumbnailUrl = publicUrl(thumbnailPath);
    return {
      id: record.id, kind: record.media_type, name: record.original_name || 'Un recuerdo de Marcela',
      originalUrl: publicUrl(record.original_path), originalPath: record.original_path,
      viewUrl: publicUrl(record.media_type === 'photo' ? record.optimized_path || record.original_path : record.original_path),
      thumbnailUrl: record.media_type === 'video' && thumbnailUrl ? thumbnailUrl + '?v=2' : thumbnailUrl,
      duration: Number(record.duration) || 0
    };
  }

  function createMemoryCard(memory) {
    const card = element('button', 'moments-card');
    card.type = 'button';
    card.dataset.memoryId = memory.id;
    card.setAttribute('aria-label', 'Abrir ' + (memory.kind === 'photo' ? 'foto: ' : 'video: ') + memory.name);
    const imageWrap = element('span', 'moments-card__image');
    if (memory.thumbnailUrl) {
      const image = document.createElement('img');
      image.src = memory.thumbnailUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => {
        if (memory.kind === 'photo' && image.src !== memory.viewUrl) image.src = memory.viewUrl;
        else {
          image.remove();
          imageWrap.prepend(icon(memory.kind === 'photo' ? 'photos' : 'video'));
        }
      }, { once: true });
      imageWrap.append(image);
    } else imageWrap.append(icon(memory.kind === 'photo' ? 'photos' : 'video'));
    const badge = element('span', 'moments-card__badge');
    badge.append(icon(memory.kind === 'photo' ? 'photos' : 'play'));
    badge.append(document.createTextNode(memory.kind === 'photo' ? 'Foto' : memory.duration ? formatDuration(memory.duration) : 'Video'));
    imageWrap.append(badge);
    card.append(imageWrap, element('span', 'moments-card__name', memory.name));
    return card;
  }

  function bindLightbox() {
    const dialog = $('#memoryLightbox');
    $('#closeLightbox').addEventListener('click', () => dialog.close());
    $('#previousMemory').addEventListener('click', () => showAdjacent(-1));
    $('#nextMemory').addEventListener('click', () => showAdjacent(1));
    $('#downloadMemory').addEventListener('click', downloadMemory);
    $('#shareMemory').addEventListener('click', shareMemory);
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      releaseMedia($('#lightboxMedia'));
      $('#lightboxMedia').replaceChildren();
      const opener = state.opener;
      const replacement = Array.from($('#memoriesGallery').children).find((card) => card.dataset.memoryId === state.active?.id);
      state.active = null;
      state.opener = null;
      state.swipeStartX = null;
      (opener?.isConnected ? opener : replacement || $('#refreshGallery')).focus({ preventScroll: true });
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.target.closest('video')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        showAdjacent(event.key === 'ArrowLeft' ? -1 : 1);
      }
    });
    const media = $('#lightboxMedia');
    media.addEventListener('pointerdown', (event) => {
      if (state.active?.kind === 'photo' && event.pointerType === 'touch') state.swipeStartX = event.clientX;
    });
    media.addEventListener('pointerup', (event) => {
      if (state.swipeStartX === null) return;
      const delta = event.clientX - state.swipeStartX;
      state.swipeStartX = null;
      if (Math.abs(delta) > 52) showAdjacent(delta > 0 ? -1 : 1);
    });
    media.addEventListener('pointercancel', () => { state.swipeStartX = null; });
  }

  function openMemory(id, opener) {
    const memory = state.memories.find((entry) => entry.id === id);
    if (!memory) return;
    state.active = memory;
    state.opener = opener;
    renderMemory();
    $('#memoryLightbox').showModal();
    $('#closeLightbox').focus();
  }

  function renderMemory() {
    const memory = state.active;
    if (!memory) return;
    const container = $('#lightboxMedia');
    releaseMedia(container);
    container.replaceChildren();
    const media = document.createElement(memory.kind === 'photo' ? 'img' : 'video');
    if (memory.kind === 'photo') media.alt = 'Foto compartida: ' + memory.name;
    else {
      media.controls = true;
      media.playsInline = true;
      media.preload = 'metadata';
      if (memory.thumbnailUrl) media.poster = memory.thumbnailUrl;
    }
    media.src = memory.viewUrl;
    media.addEventListener('error', () => setFeedback('#lightboxStatus',
      memory.kind === 'video' ? 'Este navegador no pudo reproducir el video. Puedes descargarlo para abrirlo en tu dispositivo.'
        : 'No se pudo abrir la foto. Puedes intentar descargarla.', 'error'), { once: true });
    container.append(media);
    $('#lightboxCaption').textContent = memory.name;
    $('#previousMemory').disabled = state.memories.length < 2;
    $('#nextMemory').disabled = state.memories.length < 2;
    $('#downloadMemory').disabled = false;
    $('#shareMemory').disabled = false;
    $('#shareLink').hidden = true;
    setFeedback('#lightboxStatus', '', '');
  }

  function showAdjacent(direction) {
    if (!state.active || state.memories.length < 2) return;
    const index = state.memories.findIndex((entry) => entry.id === state.active.id);
    state.active = state.memories[(index + direction + state.memories.length) % state.memories.length];
    renderMemory();
  }

  async function downloadMemory() {
    const memory = state.active;
    if (!memory) return;
    const button = $('#downloadMemory');
    button.disabled = true;
    setFeedback('#lightboxStatus', 'Preparando la descarga…', '');
    const name = safeFileName(memory.name) + '.' + getExtension(memory.originalPath);
    try {
      if (memory.kind === 'video') {
        clickDownload(memory.originalUrl + '?download=' + encodeURIComponent(name), name);
        if (state.active === memory) setFeedback('#lightboxStatus', 'Descarga del video iniciada.', 'success');
        return;
      }
      const response = await fetch(memory.originalUrl, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error('download');
      const url = URL.createObjectURL(await response.blob());
      clickDownload(url, name);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      if (state.active === memory) setFeedback('#lightboxStatus', 'Descarga preparada.', 'success');
    } catch {
      clickDownload(memory.originalUrl + '?download=' + encodeURIComponent(name), name);
      if (state.active === memory) setFeedback('#lightboxStatus', 'Abriendo la descarga del recuerdo.', '');
    } finally {
      button.disabled = false;
    }
  }

  async function shareMemory() {
    const memory = state.active;
    if (!memory) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Un recuerdo de Marcela', text: 'Un momento especial de la celebración.', url: memory.viewUrl });
        if (state.active === memory) setFeedback('#lightboxStatus', 'Recuerdo compartido.', 'success');
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(memory.viewUrl);
        if (state.active === memory) setFeedback('#lightboxStatus', 'Enlace copiado para compartir.', 'success');
      } else showShareLink(memory);
    } catch (error) {
      if (error.name !== 'AbortError' && state.active === memory) showShareLink(memory);
    }
  }

  function showShareLink(memory) {
    const input = $('#shareLink');
    input.value = memory.viewUrl;
    input.hidden = false;
    input.focus();
    input.select();
    setFeedback('#lightboxStatus', 'Copia este enlace para compartir el recuerdo.', '');
  }

  function clickDownload(url, name) {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  }

  function friendlyError(error, fallback, kind) {
    if (error.code === 'ALBUM_CAPACITY_REACHED') return 'No se pudo subir este recuerdo: superaría el límite compartido de 5 GB del álbum.';
    if (error.code === 'PHOTO_TOO_LARGE' || error.status === 413 && kind === 'photo'
      || error.message === 'La fotografía no puede superar 50 MB por archivo.') return 'La fotografía no puede superar 50 MB por archivo.';
    if (error.code === 'VIDEO_TOO_LARGE' || error.status === 413 && kind === 'video') return 'El video no puede superar 250 MB por archivo.';
    if (error.code === 'INVALID_FILE' && kind === 'photo' || kind === 'photo'
      && /no se pudo procesar|no se pudo preparar|este navegador no pudo abrir/i.test(error.message)) {
      return 'Selecciona una fotografía compatible.';
    }
    if (error.code === 'INVALID_FILE' && kind === 'video') return 'Selecciona un video compatible.';
    if (error.message === 'No pudimos conectar con el álbum. Inténtalo nuevamente.' || error.status >= 500
      || error.status === 401 || error.status === 403 || error.status === 404) {
      return 'No pudimos conectar con el álbum. Inténtalo nuevamente.';
    }
    if (error.status >= 400) return fallback;
    return error.message === 'Subida cancelada.' ? error.message : fallback;
  }

  function setUploadState(item, status, message, progress) {
    item.status = status;
    item.message = message;
    item.progress = Math.max(0, Math.min(100, Math.round(progress)));
    renderUploadItem(item);
  }

  function checkCancelled(item) {
    if (item.cancelled) throw new DOMException('Subida cancelada.', 'AbortError');
  }

  function isActive(item) { return item.status === 'processing' || item.status === 'uploading'; }
  function hasConnectionConfig() { return Boolean(CONFIG?.storage?.provider === 'cloudflare-r2' && baseUrl() && CONFIG?.paths?.photos === 'marcela-98'); }
  function baseUrl() {
    const configured = CONFIG?.storage?.apiBaseUrl?.replace(/\/+$/, '');
    if (configured) return configured;
    return ['127.0.0.1', 'localhost'].includes(location.hostname) ? 'http://127.0.0.1:8787' : '';
  }
  function encodePath(path) { return String(path).split('/').map(encodeURIComponent).join('/'); }
  function publicUrl(path) { return path ? baseUrl() + '/media/' + encodePath(path) : ''; }
  function getExtension(name) { return String(name).split('.').pop().toLowerCase(); }
  function createId() { return crypto.randomUUID(); }
  function safeFileName(name) { return String(name).replace(/\.[^.]+$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'recuerdo-marcela'; }
  function formatBytes(bytes) { return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / (1024 * 1024)).toFixed(1).replace('.0', '') + ' MB'; }
  function formatDuration(seconds) { const value = Math.floor(seconds); return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0'); }
  function scrollBehavior() { return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; }
  function element(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node; }
  function setFeedback(selector, message, status) { const node = $(selector); node.textContent = message; node.dataset.state = status; }
  function icon(name) {
    const image = document.createElement('img');
    image.className = 'moments-icon';
    image.src = 'assets/iconos-marcela-marfil/' + name + '.webp';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.decoding = 'async';
    image.width = 48;
    image.height = 48;
    image.dataset.icon = name;
    return image;
  }
  function releaseMedia(root) {
    for (const video of root.querySelectorAll('video')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
})();
