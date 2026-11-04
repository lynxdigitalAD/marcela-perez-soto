const EVENT = 'marcela-98';
const EVENT_PREFIX = EVENT + '/';
const SESSION_PREFIX = 'private/uploads/' + EVENT + '/';
const MANIFEST_PREFIX = 'private/album/' + EVENT + '/';
const MAX_ALBUM_BYTES = 5_000_000_000;
const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MULTIPART_CHUNK_BYTES = 8 * 1024 * 1024;
const STALE_UPLOAD_MS = 48 * 60 * 60 * 1000;
const STALE_RESERVATION_BATCH_SIZE = 100;
const PAGE_SIZE = 10;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp('^' + UUID_SOURCE + '$');
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm'
};

class AlbumError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export default {
  scheduled(controller, env, ctx) {
    ctx.waitUntil(sweepStaleUploads(env, controller.scheduledTime).catch(error => {
      console.error('Stale album upload cleanup failed:', error?.message || 'unknown');
    }));
  },
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    const cors = new Headers({
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Upload-Id, X-Upload-Part-Number, Content-Range, Range, If-None-Match, If-Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag, Accept-Ranges',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
    });
    if (origin && allowedOrigins.includes(origin)) cors.set('Access-Control-Allow-Origin', origin);

    let response;
    try {
      if (origin && !allowedOrigins.includes(origin)) {
        throw new AlbumError(403, 'ORIGIN_NOT_ALLOWED', 'Esta página no tiene acceso al álbum.');
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !origin) {
        throw new AlbumError(403, 'ORIGIN_REQUIRED', 'Abre el álbum desde la invitación.');
      }
      if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else if (!env.MARCELA_BUCKET || !env.ALBUM_QUOTA) {
        throw new AlbumError(503, 'ALBUM_NOT_CONFIGURED', 'El álbum todavía necesita terminar su configuración.');
      } else response = await route(request, env);
    } catch (error) {
      if (!(error instanceof AlbumError)) console.error('Album R2 request failed:', error?.message || 'unknown');
      response = json({
        code: error instanceof AlbumError ? error.code : 'ALBUM_REQUEST_FAILED',
        message: error instanceof AlbumError ? error.message : 'No pudimos completar la solicitud del álbum.'
      }, error.status || 500);
    }

    const headers = new Headers(response.headers);
    for (const [key, value] of cors) headers.set(key, value);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(response.body, { status: response.status, headers });
  }
};

export class MarcelaAlbumQuota {
  constructor(ctx) {
    this.ctx = ctx;
    const sql = ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS album_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), used_bytes INTEGER NOT NULL DEFAULT 0, reconciling INTEGER NOT NULL DEFAULT 0);' +
      'INSERT OR IGNORE INTO album_state (singleton, used_bytes, reconciling) VALUES (1, 0, 0);' +
      "CREATE TABLE IF NOT EXISTS reservations (upload_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, token_hash TEXT NOT NULL, media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'video')), file_count INTEGER NOT NULL, created_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS album_items (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'video')), token_hash TEXT NOT NULL, delete_pending INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);"
    );
  }

  async fetch(request) {
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED', message: 'Método no permitido.' }, 405);
    let input;
    try { input = await readJson(request); }
    catch (error) { return errorResponse(error); }
    try {
      switch (new URL(request.url).pathname.slice(1)) {
        case 'reserve': return this.reserve(input);
        case 'commit': return this.commit(input);
        case 'release': return this.release(input);
        case 'status': return this.status(input);
        case 'begin-delete': return this.beginDelete(input);
        case 'confirm-delete': return this.confirmDelete(input);
        case 'cancel-delete': return this.cancelDelete(input);
        case 'usage': return this.usage();
        case 'stale-reservations': return this.staleReservations(input);
        case 'begin-reconcile': return this.beginReconcile();
        case 'finish-reconcile': return this.finishReconcile(input);
        case 'cancel-reconcile': return this.cancelReconcile();
        default: return json({ code: 'NOT_FOUND', message: 'No encontramos este recurso interno.' }, 404);
      }
    } catch (error) {
      return errorResponse(error);
    }
  }

  reserve(input) {
    const { id, bytes, tokenHash, mediaType, fileCount } = input || {};
    if (!UUID.test(id || '') || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ALBUM_BYTES
      || !/^[0-9a-f]{64}$/.test(tokenHash || '') || !['photo', 'video'].includes(mediaType)
      || !Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > 3) {
      throw new AlbumError(400, 'INVALID_RESERVATION', 'La reserva de espacio no es válida.');
    }
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existingReservation = sqlRows(sql, 'SELECT * FROM reservations WHERE upload_id = ?', id)[0];
      if (existingReservation) {
        if (existingReservation.bytes !== bytes || existingReservation.token_hash !== tokenHash
          || existingReservation.media_type !== mediaType || existingReservation.file_count !== fileCount) {
          throw new AlbumError(409, 'UPLOAD_CONFLICT', 'Esta subida ya se preparó con otros datos.');
        }
        return json({ status: 'reserved', bytes });
      }
      const existingItem = sqlRows(sql, 'SELECT * FROM album_items WHERE id = ?', id)[0];
      if (existingItem) {
        if (existingItem.bytes !== bytes || existingItem.token_hash !== tokenHash || existingItem.media_type !== mediaType) {
          throw new AlbumError(409, 'UPLOAD_CONFLICT', 'Este recuerdo ya existe con otros datos.');
        }
        return json({ status: 'committed', bytes: existingItem.bytes });
      }
      const state = sqlRows(sql, 'SELECT * FROM album_state WHERE singleton = 1')[0];
      if (state.reconciling) throw new AlbumError(503, 'ALBUM_RECONCILING', 'El álbum se está verificando. Inténtalo nuevamente en un momento.');
      const reserved = sqlRows(sql, 'SELECT COALESCE(SUM(bytes), 0) AS bytes FROM reservations')[0].bytes;
      if (state.used_bytes + reserved + bytes > MAX_ALBUM_BYTES) {
        throw new AlbumError(507, 'ALBUM_CAPACITY_REACHED', 'No se pudo subir este recuerdo: superaría el límite compartido de 5 GB del álbum.');
      }
      sql.exec(
        'INSERT INTO reservations (upload_id, bytes, token_hash, media_type, file_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, bytes, tokenHash, mediaType, fileCount, new Date().toISOString()
      );
      return json({ status: 'reserved', bytes });
    });
  }

  commit(input) {
    const { id, bytes, tokenHash, mediaType } = input || {};
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const item = sqlRows(sql, 'SELECT * FROM album_items WHERE id = ?', id)[0];
      if (item) {
        if (item.bytes !== bytes || item.token_hash !== tokenHash || item.media_type !== mediaType) {
          throw new AlbumError(409, 'UPLOAD_CONFLICT', 'Este recuerdo ya existe con otros datos.');
        }
        return json({ status: 'committed', bytes: item.bytes });
      }
      const reservation = sqlRows(sql, 'SELECT * FROM reservations WHERE upload_id = ?', id)[0];
      if (!reservation || reservation.bytes !== bytes || reservation.token_hash !== tokenHash
        || reservation.media_type !== mediaType) {
        throw new AlbumError(409, 'RESERVATION_NOT_FOUND', 'La reserva de esta subida ya no está disponible.');
      }
      const state = sqlRows(sql, 'SELECT * FROM album_state WHERE singleton = 1')[0];
      if (state.reconciling) throw new AlbumError(503, 'ALBUM_RECONCILING', 'El álbum se está verificando. Inténtalo nuevamente en un momento.');
      sql.exec('UPDATE album_state SET used_bytes = used_bytes + ? WHERE singleton = 1', reservation.bytes);
      sql.exec(
        'INSERT INTO album_items (id, bytes, media_type, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        id, reservation.bytes, mediaType, tokenHash, new Date().toISOString()
      );
      sql.exec('DELETE FROM reservations WHERE upload_id = ?', id);
      return json({ status: 'committed', bytes: reservation.bytes });
    });
  }

  release(input) {
    const { id, tokenHash } = input || {};
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const item = sqlRows(sql, 'SELECT * FROM album_items WHERE id = ?', id)[0];
      if (item) {
        if (item.token_hash !== tokenHash) throw new AlbumError(403, 'UPLOAD_TOKEN_INVALID', 'Esta autorización no corresponde a la subida.');
        return json({ status: 'committed', bytes: item.bytes });
      }
      const reservation = sqlRows(sql, 'SELECT * FROM reservations WHERE upload_id = ?', id)[0];
      if (!reservation) return json({ status: 'released', bytes: 0 });
      if (reservation.token_hash !== tokenHash) throw new AlbumError(403, 'UPLOAD_TOKEN_INVALID', 'Esta autorización no corresponde a la subida.');
      sql.exec('DELETE FROM reservations WHERE upload_id = ?', id);
      return json({ status: 'released', bytes: reservation.bytes });
    });
  }

  status(input) {
    const { id, tokenHash } = input || {};
    const sql = this.ctx.storage.sql;
    const item = sqlRows(sql, 'SELECT * FROM album_items WHERE id = ?', id)[0];
    if (item) {
      if (item.token_hash !== tokenHash) throw new AlbumError(403, 'UPLOAD_TOKEN_INVALID', 'Esta autorización no corresponde a la subida.');
      return json({ status: 'committed', bytes: item.bytes });
    }
    const reservation = sqlRows(sql, 'SELECT * FROM reservations WHERE upload_id = ?', id)[0];
    if (!reservation) return json({ status: 'missing' });
    if (reservation.token_hash !== tokenHash) throw new AlbumError(403, 'UPLOAD_TOKEN_INVALID', 'Esta autorización no corresponde a la subida.');
    return json({ status: 'reserved', bytes: reservation.bytes });
  }

  beginDelete(input) {
    const id = input?.id;
    if (!UUID.test(id || '')) throw new AlbumError(400, 'INVALID_MEMORY_ID', 'El recuerdo no es válido.');
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const state = sqlRows(sql, 'SELECT * FROM album_state WHERE singleton = 1')[0];
      if (state.reconciling) throw new AlbumError(503, 'ALBUM_RECONCILING', 'El álbum se está verificando. Inténtalo nuevamente.');
      const item = sqlRows(sql, 'SELECT * FROM album_items WHERE id = ?', id)[0];
      if (!item) throw new AlbumError(404, 'MEMORY_NOT_FOUND', 'No encontramos este recuerdo.');
      if (item.delete_pending) return json({ status: 'deleting', bytes: item.bytes, mediaType: item.media_type });
      sql.exec('UPDATE album_items SET delete_pending = 1 WHERE id = ?', id);
      return json({ status: 'deleting', bytes: item.bytes, mediaType: item.media_type });
    });
  }

  confirmDelete(input) {
    const id = input?.id;
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const item = sqlRows(sql, 'SELECT * FROM album_items WHERE id = ?', id)[0];
      if (!item || !item.delete_pending) throw new AlbumError(409, 'DELETE_NOT_PREPARED', 'No se pudo confirmar la eliminación.');
      sql.exec('UPDATE album_state SET used_bytes = MAX(0, used_bytes - ?) WHERE singleton = 1', item.bytes);
      sql.exec('DELETE FROM album_items WHERE id = ?', id);
      return json({ status: 'deleted', bytes: item.bytes });
    });
  }

  cancelDelete(input) {
    const id = input?.id;
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE album_items SET delete_pending = 0 WHERE id = ?', id);
      return json({ status: 'ready' });
    });
  }

  usage() {
    const sql = this.ctx.storage.sql;
    const state = sqlRows(sql, 'SELECT * FROM album_state WHERE singleton = 1')[0];
    const reserved = sqlRows(sql, 'SELECT COALESCE(SUM(bytes), 0) AS bytes FROM reservations')[0].bytes;
    const counts = sqlRows(sql, "SELECT media_type, COUNT(*) AS count FROM album_items GROUP BY media_type");
    const photos = counts.find(row => row.media_type === 'photo')?.count || 0;
    const videos = counts.find(row => row.media_type === 'video')?.count || 0;
    return json({
      bytesUsed: state.used_bytes, bytesReserved: reserved, bytesAllocated: state.used_bytes + reserved,
      bytesMaximum: MAX_ALBUM_BYTES,
      percentage: Number(((state.used_bytes + reserved) / MAX_ALBUM_BYTES * 100).toFixed(6)),
      photoCount: photos, videoCount: videos, itemCount: photos + videos,
      reconciling: Boolean(state.reconciling)
    });
  }

  staleReservations(input) {
    const olderThan = input?.olderThan;
    const parsedOlderThan = typeof olderThan === 'string' ? Date.parse(olderThan) : NaN;
    const requestedLimit = input?.limit ?? STALE_RESERVATION_BATCH_SIZE;
    if (!Number.isFinite(parsedOlderThan) || !Number.isSafeInteger(requestedLimit)
      || requestedLimit < 1 || requestedLimit > STALE_RESERVATION_BATCH_SIZE) {
      throw new AlbumError(400, 'INVALID_STALE_UPLOAD_QUERY', 'La búsqueda de subidas vencidas no es válida.');
    }
    const rows = sqlRows(this.ctx.storage.sql,
      'SELECT upload_id, token_hash FROM reservations WHERE created_at < ? ORDER BY created_at ASC LIMIT ?',
      new Date(parsedOlderThan).toISOString(), requestedLimit);
    return json({ reservations: rows.map(row => ({ id: row.upload_id, tokenHash: row.token_hash })) });
  }

  beginReconcile() {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const state = sqlRows(sql, 'SELECT * FROM album_state WHERE singleton = 1')[0];
      const reservations = sqlRows(sql, 'SELECT COUNT(*) AS count FROM reservations')[0].count;
      const pendingDeletes = sqlRows(sql, 'SELECT COUNT(*) AS count FROM album_items WHERE delete_pending = 1')[0].count;
      if (state.reconciling || reservations || pendingDeletes) {
        throw new AlbumError(409, 'ALBUM_BUSY', 'Hay subidas o eliminaciones en proceso. Vuelve a intentar la reconciliación después.');
      }
      sql.exec('UPDATE album_state SET reconciling = 1 WHERE singleton = 1');
      return json({ status: 'locked' });
    });
  }

  finishReconcile(input) {
    const { usedBytes, items } = input || {};
    if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 || !Array.isArray(items)
      || items.length > 1_000_000 || !items.every(item => UUID.test(item?.id || '')
        && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && ['photo', 'video'].includes(item.mediaType)
        && /^[0-9a-f]{64}$/.test(item.tokenHash || ''))) {
      throw new AlbumError(400, 'INVALID_RECONCILIATION', 'Los datos de la reconciliación no son válidos.');
    }
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const state = sqlRows(sql, 'SELECT * FROM album_state WHERE singleton = 1')[0];
      if (!state.reconciling) throw new AlbumError(409, 'RECONCILIATION_NOT_STARTED', 'La reconciliación no está activa.');
      sql.exec('DELETE FROM album_items');
      for (const item of items) {
        sql.exec(
          'INSERT INTO album_items (id, bytes, media_type, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
          item.id, item.bytes, item.mediaType, item.tokenHash, new Date().toISOString()
        );
      }
      sql.exec('UPDATE album_state SET used_bytes = ?, reconciling = 0 WHERE singleton = 1', usedBytes);
      return json({ status: 'reconciled', bytesUsed: usedBytes, itemCount: items.length });
    });
  }

  cancelReconcile() {
    this.ctx.storage.sql.exec('UPDATE album_state SET reconciling = 0 WHERE singleton = 1');
    return json({ status: 'unlocked' });
  }
}

async function sweepStaleUploads(env, scheduledTime = Date.now()) {
  const cutoff = new Date(scheduledTime - STALE_UPLOAD_MS);
  const bucket = env.MARCELA_BUCKET;
  let cleaned = 0;
  let pending = 0;
  const invalidSessions = new Set();
  let cursor;

  do {
    const listing = await bucket.list({
      prefix: SESSION_PREFIX, limit: 1000, ...(cursor ? { cursor } : {})
    });
    for (const object of listing.objects) {
      const uploadedAt = object.uploaded?.getTime?.();
      if (!Number.isFinite(uploadedAt) || uploadedAt >= cutoff.getTime()) continue;
      const id = object.key.slice(SESSION_PREFIX.length).replace(/\.json$/, '');
      if (!UUID.test(id)) continue;

      try {
        const stored = await bucket.get(object.key);
        if (!stored) continue;
        const latestUploadedAt = stored.uploaded?.getTime?.();
        if (!Number.isFinite(latestUploadedAt) || latestUploadedAt >= cutoff.getTime()) continue;
        const session = await stored.json().catch(() => null);
        if (!session || session.record?.id !== id || !/^[0-9a-f]{64}$/.test(session.tokenHash || '')) {
          invalidSessions.add(id);
          console.error('Expired album upload session is invalid; safe cleanup will be attempted.');
          continue;
        }
        const result = await cleanupFailedUpload(env, session, session.tokenHash);
        if (result === 'released' || result === 'committed') cleaned += 1;
        else pending += 1;
      } catch (error) {
        pending += 1;
        console.error('Expired album upload cleanup will retry:', error?.message || 'unknown');
      }
    }
    const next = listing.truncated ? listing.cursor : undefined;
    if (listing.truncated && (!next || next === cursor)) throw new Error('Incomplete stale-session listing');
    cursor = next;
  } while (cursor);

  const stale = await quotaCall(env, 'stale-reservations', {
    olderThan: cutoff.toISOString(), limit: STALE_RESERVATION_BATCH_SIZE
  });
  for (const reservation of stale.reservations) {
    const sessionKey = SESSION_PREFIX + reservation.id + '.json';
    let sessionObject;
    try { sessionObject = await bucket.head(sessionKey); }
    catch {
      pending += 1;
      continue;
    }
    if (sessionObject) {
      if (!invalidSessions.has(reservation.id)) continue;
      try {
        const result = await cleanupCorruptStaleUpload(env, reservation.id, reservation.tokenHash);
        if (result === 'released' || result === 'committed') {
          cleaned += 1;
          invalidSessions.delete(reservation.id);
        } else pending += 1;
      } catch (error) {
        pending += 1;
        console.error('Corrupt album upload cleanup will retry:', error?.message || 'unknown');
      }
      continue;
    }
    try {
      const result = await quotaCall(env, 'release', {
        id: reservation.id, tokenHash: reservation.tokenHash
      });
      if (result.status === 'released' || result.status === 'committed') cleaned += 1;
      else pending += 1;
    } catch (error) {
      pending += 1;
      console.error('Orphaned album quota reservation cleanup will retry:', error?.message || 'unknown');
    }
  }

  pending += invalidSessions.size;
  console.log(`Stale album upload sweep completed: ${cleaned} cleaned, ${pending} pending.`);
}

async function cleanupCorruptStaleUpload(env, id, tokenHash) {
  const bucket = env.MARCELA_BUCKET;
  const status = await quotaCall(env, 'status', { id, tokenHash });
  const sessionKey = SESSION_PREFIX + id + '.json';
  if (status.status === 'committed') {
    await bucket.delete(sessionKey);
    return 'committed';
  }

  for (const prefix of [EVENT_PREFIX, MANIFEST_PREFIX]) {
    let cursor;
    do {
      const listing = await bucket.list({
        prefix, limit: 1000, include: ['customMetadata'], ...(cursor ? { cursor } : {})
      });
      for (const object of listing.objects) {
        if (object.customMetadata?.uploadId === id) await bucket.delete(object.key);
      }
      const next = listing.truncated ? listing.cursor : undefined;
      if (listing.truncated && (!next || next === cursor)) throw new Error('Incomplete corrupt-upload listing');
      cursor = next;
    } while (cursor);
  }

  const released = await quotaCall(env, 'release', { id, tokenHash });
  if (released.status !== 'released') return 'pending';
  await bucket.delete(sessionKey);
  return 'released';
}

async function route(request, env) {
  const url = new URL(request.url);
  const bucket = env.MARCELA_BUCKET;
  const base = '/api/events/' + EVENT;

  if (request.method === 'GET' && url.pathname === '/health') {
    return json({
      provider: 'cloudflare-r2', event: EVENT, maxAlbumBytes: MAX_ALBUM_BYTES,
      maxPhotoBytes: MAX_PHOTO_BYTES, maxVideoBytes: MAX_VIDEO_BYTES, pageSize: PAGE_SIZE
    });
  }
  if (request.method === 'GET' && (url.pathname === base + '/memories' || url.pathname === base + '/photos')) {
    return listMemories(url, bucket, url.pathname.endsWith('/photos') ? 'photo' : null);
  }
  if (request.method === 'POST' && url.pathname === base + '/uploads') return beginUpload(request, env);
  if (request.method === 'PUT' && url.pathname.startsWith(base + '/objects/')) {
    return putFile(request, env, decodePath(url.pathname.slice((base + '/objects/').length)));
  }
  if (request.method === 'POST' && url.pathname === base + '/memories') return commitUpload(request, env);

  const cancelMatch = url.pathname.match(new RegExp('^' + base + '/uploads/(' + UUID_SOURCE + ')$'));
  if (request.method === 'DELETE' && cancelMatch) return cancelUpload(request, env, cancelMatch[1]);

  const deleteMatch = url.pathname.match(new RegExp('^' + base + '/memories/(' + UUID_SOURCE + ')$'));
  if (request.method === 'DELETE' && deleteMatch) return deleteMemory(request, env, deleteMatch[1]);

  if (request.method === 'GET' && url.pathname === base + '/usage') {
    requireAdmin(request, env);
    return json(await quotaCall(env, 'usage', {}));
  }
  if (request.method === 'POST' && url.pathname === base + '/usage/reconcile') {
    requireAdmin(request, env);
    return json(await reconcile(env, bucket));
  }
  if (['GET', 'HEAD'].includes(request.method) && url.pathname.startsWith('/media/')) {
    return getFile(request, bucket, decodePath(url.pathname.slice('/media/'.length)));
  }
  throw new AlbumError(404, 'NOT_FOUND', 'No encontramos este recurso del álbum.');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function errorResponse(error) {
  return json({
    code: error instanceof AlbumError ? error.code : 'ALBUM_REQUEST_FAILED',
    message: error instanceof AlbumError ? error.message : 'No pudimos completar la solicitud del álbum.'
  }, error.status || 500);
}

async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AlbumError(400, 'MISSING_BODY', 'Faltan los datos del recuerdo.');
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 16384) {
      await reader.cancel();
      throw new AlbumError(413, 'BODY_TOO_LARGE', 'Los datos del recuerdo son demasiado largos.');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new AlbumError(400, 'INVALID_JSON', 'Los datos del recuerdo no son válidos.'); }
}

function decodePath(value) {
  try { return decodeURIComponent(value); }
  catch { throw new AlbumError(400, 'INVALID_PATH', 'La ruta del archivo no es válida.'); }
}

function pathInfo(path, id) {
  if (typeof path !== 'string') throw new AlbumError(400, 'INVALID_PATH', 'La ruta del archivo no pertenece a este recuerdo.');
  let match = path.match(new RegExp('^' + EVENT + '/(' + UUID_SOURCE + ')\\.(jpg|jpeg|png|webp)$'));
  if (match) {
    if (id && match[1] !== id) throw new AlbumError(400, 'INVALID_PATH', 'La ruta del archivo no pertenece a este recuerdo.');
    return { type: TYPES[match[2]], role: 'photo', mediaType: 'photo' };
  }
  match = path.match(new RegExp('^' + EVENT + '/videos/(' + UUID_SOURCE + ')\\.(mp4|mov|webm)$'));
  if (match) {
    if (id && match[1] !== id) throw new AlbumError(400, 'INVALID_PATH', 'La ruta del archivo no pertenece a este recuerdo.');
    return { type: TYPES[match[2]], role: 'video', mediaType: 'video' };
  }
  match = path.match(new RegExp('^' + EVENT + '/thumbnails/(' + UUID_SOURCE + ')\\.(jpg|jpeg|png|webp)$'));
  if (match) {
    if (id && match[1] !== id) throw new AlbumError(400, 'INVALID_PATH', 'La ruta del archivo no pertenece a este recuerdo.');
    return { type: TYPES[match[2]], role: 'thumbnail', mediaType: 'video' };
  }
  throw new AlbumError(400, 'INVALID_PATH', 'La ruta del archivo no pertenece al álbum de Marcela.');
}

function cleanOriginalName(value) {
  if (typeof value !== 'string') throw new AlbumError(400, 'INVALID_FILE_NAME', 'Revisa el nombre del archivo.');
  const name = value.replace(/\\/g, '/').split('/').pop()
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  if (!name || name === '.' || name === '..') throw new AlbumError(400, 'INVALID_FILE_NAME', 'Revisa el nombre del archivo.');
  return name;
}

function normaliseUpload(input) {
  const source = input?.record;
  if (!source || !UUID.test(source.id || '') || !['photo', 'video'].includes(source.media_type)) {
    throw new AlbumError(400, 'INVALID_MEMORY', 'El recuerdo no es válido.');
  }
  const originalName = cleanOriginalName(source.original_name);
  const originalInfo = pathInfo(source.original_path, source.id);
  const expectedMediaType = source.media_type;
  if (originalInfo.role !== expectedMediaType || source.mime_type !== originalInfo.type) {
    throw new AlbumError(400, 'INVALID_MEDIA_TYPE', 'El tipo de recuerdo no coincide con su archivo.');
  }
  const photo = expectedMediaType === 'photo';
  const maxOriginal = photo ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
  if (!Number.isSafeInteger(source.file_size) || source.file_size < 1 || source.file_size > maxOriginal) {
    throw new AlbumError(413, photo ? 'PHOTO_TOO_LARGE' : 'VIDEO_TOO_LARGE',
      photo ? 'La fotografía no puede superar 50 MB por archivo.' : 'El video no puede superar 250 MB por archivo.');
  }

  const paths = [source.original_path];
  if (photo) {
    if (source.optimized_path || source.thumbnail_path) {
      throw new AlbumError(400, 'INVALID_PHOTO_ARTIFACTS', 'La fotografía debe estar optimizada antes de subirla.');
    }
  } else {
    if (source.optimized_path) throw new AlbumError(400, 'INVALID_VIDEO_ARTIFACTS', 'El video no admite una vista optimizada.');
    if (source.thumbnail_path) {
      const thumbnailInfo = pathInfo(source.thumbnail_path, source.id);
      if (thumbnailInfo.role !== 'thumbnail') throw new AlbumError(400, 'INVALID_THUMBNAIL', 'La portada del video no es válida.');
      paths.push(source.thumbnail_path);
    }
  }
  if (!Array.isArray(input.files) || input.files.length !== paths.length) {
    throw new AlbumError(400, 'INVALID_FILE_LIST', 'Revisa los archivos que forman el recuerdo.');
  }
  const files = paths.map(path => {
    const file = input.files.find(item => item && item.path === path);
    const info = pathInfo(path, source.id);
    if (!file || file.mime_type !== info.type) throw new AlbumError(400, 'INVALID_FILE_TYPE', 'El formato del archivo no es válido.');
    const max = info.role === 'video' ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES;
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > max) {
      throw new AlbumError(413, info.role === 'video' ? 'VIDEO_TOO_LARGE' : 'PHOTO_TOO_LARGE',
        info.role === 'video' ? 'El video no puede superar 250 MB por archivo.' : 'La fotografía no puede superar 50 MB por archivo.');
    }
    return { path, size: file.size, mime_type: file.mime_type, role: info.role };
  });
  if (files[0].size !== source.file_size) throw new AlbumError(400, 'SIZE_MISMATCH', 'El tamaño del recuerdo no coincide.');

  const record = {
    id: source.id, original_name: originalName, media_type: expectedMediaType,
    original_path: source.original_path, optimized_path: null, thumbnail_path: source.thumbnail_path || null,
    mime_type: source.mime_type, file_size: source.file_size,
    width: null, height: null, duration: null
  };
  for (const key of ['width', 'height', 'duration']) {
    const value = source[key];
    if (value != null && (!Number.isFinite(value) || value < 0 || value > 1_000_000)) {
      throw new AlbumError(400, 'INVALID_DIMENSIONS', 'Las dimensiones del recuerdo no son válidas.');
    }
    record[key] = value ?? null;
  }
  return { record, files, reservedBytes: files.reduce((total, file) => total + file.size, 0) };
}

async function tokenHash(request) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f-]{72})$/i)?.[1];
  if (!token) throw new AlbumError(401, 'UPLOAD_TOKEN_REQUIRED', 'Falta la autorización de esta subida. Vuelve a seleccionar el archivo.');
  return digestHex(token);
}

async function digestHex(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sessionFor(request, bucket, id) {
  if (!UUID.test(id || '')) throw new AlbumError(400, 'INVALID_UPLOAD_ID', 'La subida no es válida.');
  const hash = await tokenHash(request);
  const object = await bucket.get(SESSION_PREFIX + id + '.json');
  if (!object) throw new AlbumError(404, 'UPLOAD_NOT_FOUND', 'No encontramos la preparación de esta subida. Vuelve a intentarlo.');
  const session = await object.json();
  if (session.tokenHash !== hash) throw new AlbumError(403, 'UPLOAD_TOKEN_INVALID', 'Esta autorización no corresponde al recuerdo.');
  return { session, hash };
}

async function beginUpload(request, env) {
  const upload = normaliseUpload(await readJson(request));
  const hash = await tokenHash(request);
  const sessionKey = SESSION_PREFIX + upload.record.id + '.json';
  const existingObject = await env.MARCELA_BUCKET.get(sessionKey);
  if (existingObject) {
    const existing = await existingObject.json();
    if (existing.tokenHash !== hash || JSON.stringify(existing.record) !== JSON.stringify(upload.record)
      || JSON.stringify(existing.files) !== JSON.stringify(upload.files)) {
      throw new AlbumError(409, 'UPLOAD_CONFLICT', 'Esta subida ya se preparó con otros datos.');
    }
    const reservation = await quotaCall(env, 'reserve', {
      id: upload.record.id, bytes: upload.reservedBytes, tokenHash: hash,
      mediaType: upload.record.media_type, fileCount: upload.files.length
    });
    if (reservation.status === 'committed') return json({ status: 'committed', id: upload.record.id });
    return json({ status: 'reserved', id: upload.record.id });
  }

  const reservation = await quotaCall(env, 'reserve', {
    id: upload.record.id, bytes: upload.reservedBytes, tokenHash: hash,
    mediaType: upload.record.media_type, fileCount: upload.files.length
  });
  if (reservation.status === 'committed') {
    const manifest = await env.MARCELA_BUCKET.get(MANIFEST_PREFIX + upload.record.id + '.json');
    if (!manifest) throw new AlbumError(503, 'MANIFEST_NOT_FOUND', 'No pudimos verificar el recuerdo. Inténtalo nuevamente.');
    const saved = await manifest.json();
    if (saved.tokenHash !== hash || JSON.stringify(saved.files) !== JSON.stringify(upload.files)
      || !sameRecord(saved.record, upload.record)) {
      throw new AlbumError(409, 'UPLOAD_CONFLICT', 'Este recuerdo ya existe con otros datos.');
    }
    return json({ status: 'committed', id: upload.record.id });
  }

  const session = { ...upload, multipartUploads: {}, tokenHash: hash, created_at: new Date().toISOString() };
  const startedMultipartUploads = [];
  try {
    for (const file of upload.files) {
      if (file.role !== 'video' || file.size <= MULTIPART_CHUNK_BYTES) continue;
      const multipart = await env.MARCELA_BUCKET.createMultipartUpload(file.path, {
        httpMetadata: { contentType: file.mime_type, cacheControl: 'public, max-age=31536000, immutable' },
        customMetadata: { uploadId: upload.record.id, role: file.role }
      });
      session.multipartUploads[file.path] = { uploadId: multipart.uploadId, parts: [], completed: false };
      startedMultipartUploads.push(multipart);
    }
    const stored = await env.MARCELA_BUCKET.put(sessionKey, JSON.stringify(session), {
      onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
      customMetadata: { uploadId: upload.record.id }
    });
    if (!stored) {
      await Promise.allSettled(startedMultipartUploads.map(multipart => multipart.abort()));
      const concurrent = await env.MARCELA_BUCKET.get(sessionKey);
      const existing = concurrent ? await concurrent.json() : null;
      if (!existing || existing.tokenHash !== hash || !sameRecord(existing.record, upload.record)
        || JSON.stringify(existing.files) !== JSON.stringify(upload.files)) {
        throw new AlbumError(409, 'UPLOAD_CONFLICT', 'Esta subida ya se preparó con otros datos.');
      }
    }
  } catch (error) {
    await Promise.allSettled(startedMultipartUploads.map(multipart => multipart.abort()));
    const concurrent = await env.MARCELA_BUCKET.get(sessionKey).catch(() => null);
    if (concurrent) {
      const existing = await concurrent.json().catch(() => null);
      if (existing?.tokenHash === hash && sameRecord(existing.record, upload.record)
        && JSON.stringify(existing.files) === JSON.stringify(upload.files)) {
        return json({ status: 'reserved', id: upload.record.id });
      }
    }
    const cleanup = await quotaCall(env, 'release', { id: upload.record.id, tokenHash: hash }).catch(() => null);
    if (cleanup?.status !== 'committed') throw error;
  }
  return json({ status: 'reserved', id: upload.record.id });
}

async function quotaCall(env, action, body) {
  const id = env.ALBUM_QUOTA.idFromName(EVENT);
  const stub = env.ALBUM_QUOTA.get(id);
  const response = await stub.fetch('https://album-quota.internal/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  let result;
  try { result = await response.json(); }
  catch { throw new AlbumError(503, 'QUOTA_UNAVAILABLE', 'No pudimos comprobar el espacio del álbum. Inténtalo nuevamente.'); }
  if (!response.ok) throw new AlbumError(response.status, result.code, result.message);
  return result;
}

async function putFile(request, env, path) {
  const info = pathInfo(path);
  const uploadId = request.headers.get('X-Upload-Id');
  const { session, hash } = await sessionFor(request, env.MARCELA_BUCKET, uploadId);
  const file = session.files.find(item => item.path === path);
  if (!file) throw new AlbumError(403, 'FILE_NOT_RESERVED', 'El archivo no pertenece a esta subida.');
  const multipart = session.multipartUploads?.[path];
  if (multipart) return putMultipartPart(request, env, path, session, hash, file, multipart);
  if (request.headers.has('X-Upload-Part-Number')) {
    throw new AlbumError(400, 'UNEXPECTED_UPLOAD_PART', 'Esta subida no necesita bloques.');
  }
  const length = Number(request.headers.get('Content-Length'));
  if (length !== file.size || !request.body) {
    await cleanupFailedUpload(env, session, hash);
    throw new AlbumError(400, 'SIZE_MISMATCH', 'El tamaño enviado no coincide con el archivo.');
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== file.mime_type) {
    await cleanupFailedUpload(env, session, hash);
    throw new AlbumError(400, 'MIME_MISMATCH', 'El formato enviado no coincide con el archivo.');
  }

  try {
    const checked = inspectBody(request.body, file);
    const saved = await env.MARCELA_BUCKET.put(path, checked.readable, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: file.mime_type, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { uploadId: session.record.id, role: file.role }
    });
    await checked.done;
    if (checked.error) throw checked.error;
    if (!saved) {
      const existing = await env.MARCELA_BUCKET.head(path);
      if (!matchesFile(existing, file, session.record.id)) {
        throw new AlbumError(409, 'OBJECT_CONFLICT', 'El archivo ya existe con otros datos.');
      }
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error('R2 file validation or write failed:', error?.message || 'unknown');
    await cleanupFailedUpload(env, session, hash);
    if (error instanceof AlbumError) throw error;
    throw new AlbumError(400, 'INVALID_FILE', 'No pudimos validar el archivo. Selecciona una fotografía o un video compatible.');
  }
}

async function putMultipartPart(request, env, path, session, hash, file, multipartState) {
  const bucket = env.MARCELA_BUCKET;
  if (multipartState.completed) {
    const existing = await bucket.head(path);
    if (matchesFile(existing, file, session.record.id)) return new Response(null, { status: 204 });
    throw new AlbumError(409, 'UPLOAD_INCOMPLETE', 'Todavía falta terminar la subida. Puedes volver a intentarlo.');
  }
  const partNumber = Number(request.headers.get('X-Upload-Part-Number'));
  const range = request.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  const partCount = Math.ceil(file.size / MULTIPART_CHUNK_BYTES);
  const start = Number.isSafeInteger(partNumber) && partNumber > 0
    ? (partNumber - 1) * MULTIPART_CHUNK_BYTES : -1;
  const expectedEnd = Math.min(start + MULTIPART_CHUNK_BYTES, file.size) - 1;
  const partSize = expectedEnd - start + 1;
  if (!range || partNumber > partCount || start < 0 || Number(range[1]) !== start
    || Number(range[2]) !== expectedEnd || Number(range[3]) !== file.size
    || Number(request.headers.get('Content-Length')) !== partSize || !request.body) {
    await cleanupFailedUpload(env, session, hash);
    throw new AlbumError(400, 'INVALID_UPLOAD_PART', 'El bloque enviado no coincide con el archivo.');
  }
  if (partNumber > multipartState.parts.length + 1) {
    throw new AlbumError(409, 'UPLOAD_PART_ORDER', 'Envía los bloques del video en orden.');
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== file.mime_type) {
    await cleanupFailedUpload(env, session, hash);
    throw new AlbumError(400, 'MIME_MISMATCH', 'El formato enviado no coincide con el archivo.');
  }

  try {
    const checked = inspectBody(request.body, file, partSize, partNumber === 1);
    const multipart = bucket.resumeMultipartUpload(path, multipartState.uploadId);
    const uploadedPart = await multipart.uploadPart(partNumber, checked.readable);
    await checked.done;
    if (checked.error) throw checked.error;

    const parts = multipartState.parts.filter(part => part.partNumber !== partNumber);
    parts.push({ partNumber: uploadedPart.partNumber, etag: uploadedPart.etag });
    parts.sort((left, right) => left.partNumber - right.partNumber);
    multipartState.parts = parts;
    await bucket.put(SESSION_PREFIX + session.record.id + '.json', JSON.stringify(session), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { uploadId: session.record.id }
    });

    if (parts.length === partCount) {
      await multipart.complete(parts);
      const saved = await bucket.head(path);
      if (!matchesFile(saved, file, session.record.id)) throw new Error('completed object mismatch');
      multipartState.completed = true;
      await bucket.put(SESSION_PREFIX + session.record.id + '.json', JSON.stringify(session), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { uploadId: session.record.id }
      });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error('R2 multipart validation or write failed:', error?.message || 'unknown');
    await cleanupFailedUpload(env, session, hash);
    if (error instanceof AlbumError) throw error;
    throw new AlbumError(400, 'INVALID_FILE', 'No pudimos validar el video. Selecciona un video compatible.');
  }
}

function inspectBody(body, file, expectedSize = file.size, verifySignature = true) {
  const reader = body.getReader();
  let total = 0;
  let prefix = new Uint8Array(0);
  let checked = !verifySignature;
  const inspected = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (!checked && !hasValidSignature(prefix, file.mime_type)) throw new Error('invalid signature');
          if (total !== expectedSize) throw new Error('invalid length');
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > expectedSize) throw new Error('too many bytes');
        if (!checked) {
          const needed = Math.max(0, 16 - prefix.byteLength);
          const take = Math.min(needed, value.byteLength);
          const next = new Uint8Array(prefix.byteLength + take);
          next.set(prefix, 0);
          next.set(value.subarray(0, take), prefix.byteLength);
          prefix = next;
          if (prefix.byteLength >= 12 || total === file.size) {
            if (!hasValidSignature(prefix, file.mime_type)) throw new Error('invalid signature');
            checked = true;
          }
        }
        controller.enqueue(value);
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}); }
  });
  const fixed = new FixedLengthStream(expectedSize);
  let validationError = null;
  const done = inspected.pipeTo(fixed.writable).catch(error => { validationError = error; });
  return { readable: fixed.readable, done, get error() { return validationError; } };
}

function hasValidSignature(bytes, mime) {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (mime === 'image/webp') return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP';
  if (mime === 'video/mp4' || mime === 'video/quicktime') return ascii(bytes, 4, 4) === 'ftyp';
  if (mime === 'video/webm') return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return false;
}

function ascii(bytes, start, length) {
  let value = '';
  for (let index = start; index < start + length; index += 1) value += String.fromCharCode(bytes[index] || 0);
  return value;
}

function matchesFile(object, file, id) {
  return object && object.size === file.size && object.httpMetadata?.contentType === file.mime_type
    && object.customMetadata?.uploadId === id && object.customMetadata?.role === file.role;
}

function sameRecord(left, right) {
  if (!left || !right) return false;
  return ['id', 'original_name', 'media_type', 'original_path', 'optimized_path', 'thumbnail_path',
    'mime_type', 'file_size', 'width', 'height', 'duration']
    .every(key => (left[key] ?? null) === (right[key] ?? null));
}

async function cleanupFailedUpload(env, session, hash) {
  const bucket = env.MARCELA_BUCKET;
  const current = await quotaCall(env, 'status', { id: session.record.id, tokenHash: hash }).catch(() => null);
  if (!current) return 'pending';
  if (current?.status === 'committed') {
    await bucket.delete(SESSION_PREFIX + session.record.id + '.json').catch(() => {});
    return 'committed';
  }
  for (const [path, multipart] of Object.entries(session.multipartUploads || {})) {
    if (multipart.completed) continue;
    await bucket.resumeMultipartUpload(path, multipart.uploadId).abort().catch(() => {});
  }
  const candidates = session.files.map(file => file.path);
  candidates.push(MANIFEST_PREFIX + session.record.id + '.json');
  let canRelease = true;
  for (const key of candidates) {
    const object = await bucket.head(key).catch(() => null);
    if (!object) continue;
    if (object.customMetadata?.uploadId !== session.record.id) { canRelease = false; continue; }
    try { await bucket.delete(key); }
    catch { canRelease = false; }
  }
  if (!canRelease) return 'pending';
  const released = await quotaCall(env, 'release', { id: session.record.id, tokenHash: hash }).catch(() => null);
  if (released?.status !== 'released') return 'pending';
  await bucket.delete(SESSION_PREFIX + session.record.id + '.json').catch(() => {});
  return 'released';
}

async function commitUpload(request, env) {
  const input = await readJson(request);
  const { session, hash } = await sessionFor(request, env.MARCELA_BUCKET, input?.id);
  const objects = await Promise.all(session.files.map(file => env.MARCELA_BUCKET.head(file.path)));
  if (!objects.every((object, index) => matchesFile(object, session.files[index], session.record.id))) {
    await cleanupFailedUpload(env, session, hash);
    throw new AlbumError(409, 'UPLOAD_INCOMPLETE', 'Todavía falta terminar la subida. Puedes volver a intentarlo.');
  }
  const manifestKey = MANIFEST_PREFIX + session.record.id + '.json';
  let record;
  const existing = await env.MARCELA_BUCKET.get(manifestKey);
  if (existing) {
    const current = await existing.json();
    if (current.tokenHash !== hash || JSON.stringify(current.files) !== JSON.stringify(session.files)
      || !sameRecord(current.record, session.record)) {
      throw new AlbumError(409, 'MANIFEST_CONFLICT', 'Este recuerdo ya existe con otros datos.');
    }
    record = current.record;
  } else {
    record = { ...session.record, created_at: new Date().toISOString() };
    try {
      const saved = await env.MARCELA_BUCKET.put(manifestKey, JSON.stringify({
        record, files: session.files, tokenHash: hash, reservedBytes: session.reservedBytes
      }), {
        onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
        customMetadata: { uploadId: session.record.id }
      });
      if (!saved) throw new AlbumError(409, 'MANIFEST_CONFLICT', 'Este recuerdo ya existe con otros datos.');
    } catch (error) {
      await cleanupFailedUpload(env, session, hash);
      throw error;
    }
  }

  try {
    await quotaCall(env, 'commit', {
      id: session.record.id, bytes: session.reservedBytes, tokenHash: hash, mediaType: session.record.media_type
    });
  } catch (error) {
    await cleanupFailedUpload(env, session, hash);
    throw error;
  }
  await env.MARCELA_BUCKET.delete(SESSION_PREFIX + session.record.id + '.json').catch(() => {});
  return json({ status: 'committed', id: record.id, created_at: record.created_at });
}

async function cancelUpload(request, env, id) {
  const { session, hash } = await sessionFor(request, env.MARCELA_BUCKET, id);
  const cleaned = await cleanupFailedUpload(env, session, hash);
  if (cleaned === 'pending') throw new AlbumError(503, 'CLEANUP_PENDING', 'No pudimos liberar el espacio todavía. Inténtalo nuevamente.');
  return json({ status: cleaned === 'committed' ? 'committed' : 'cancelled' });
}

async function listMemories(url, bucket, mediaType = null) {
  const requested = Number(url.searchParams.get('page') || 1);
  if (!Number.isSafeInteger(requested) || requested < 1) throw new AlbumError(400, 'INVALID_PAGE', 'El número de página no es válido.');
  const records = [];
  let cursor;
  do {
    const listing = await bucket.list({
      prefix: MANIFEST_PREFIX, limit: 1000, include: ['customMetadata'], ...(cursor ? { cursor } : {})
    });
    for (const object of listing.objects) {
      if (!object.customMetadata?.uploadId) continue;
      const manifest = await bucket.get(object.key);
      if (!manifest) continue;
      const data = await manifest.json().catch(() => null);
      if (data?.record && data.record.id && (!mediaType || data.record.media_type === mediaType)) records.push(data.record);
    }
    const next = listing.truncated ? listing.cursor : undefined;
    if (listing.truncated && (!next || next === cursor)) throw new AlbumError(503, 'LIST_INCOMPLETE', 'No pudimos completar la lista de recuerdos. Pulsa Actualizar.');
    cursor = next;
  } while (cursor);

  records.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const total = records.length;
  const page = Math.min(requested, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  return json({ data: records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total, page, pageSize: PAGE_SIZE });
}

async function deleteMemory(request, env, id) {
  requireAdmin(request, env);
  const manifestKey = MANIFEST_PREFIX + id + '.json';
  const manifest = await env.MARCELA_BUCKET.get(manifestKey);
  const deleting = await quotaCall(env, 'begin-delete', { id });
  const knownPaths = new Set();
  if (manifest) {
    const data = await manifest.json();
    try {
      if (!data.record || data.record.id !== id || !Array.isArray(data.files)) throw new Error('invalid manifest');
      for (const file of data.files) {
        pathInfo(file.path, id);
        knownPaths.add(file.path);
      }
    } catch {
      await quotaCall(env, 'cancel-delete', { id }).catch(() => {});
      throw new AlbumError(409, 'MANIFEST_INVALID', 'No pudimos verificar los archivos de este recuerdo.');
    }
  }
  try {
    if (!manifest) {
      let cursor;
      do {
        const listing = await env.MARCELA_BUCKET.list({
          prefix: EVENT_PREFIX, limit: 1000, include: ['customMetadata'], ...(cursor ? { cursor } : {})
        });
        for (const object of listing.objects) {
          if (object.customMetadata?.uploadId === id) knownPaths.add(object.key);
        }
        const next = listing.truncated ? listing.cursor : undefined;
        if (listing.truncated && (!next || next === cursor)) throw new Error('incomplete list');
        cursor = next;
      } while (cursor);
    }
    if (knownPaths.size) await env.MARCELA_BUCKET.delete(Array.from(knownPaths));
    await env.MARCELA_BUCKET.delete(manifestKey);
  } catch {
    await quotaCall(env, 'cancel-delete', { id }).catch(() => {});
    throw new AlbumError(503, 'DELETE_FAILED', 'No pudimos eliminar el recuerdo. Inténtalo nuevamente.');
  }
  await quotaCall(env, 'confirm-delete', { id });
  return json({ status: 'deleted', id, bytesReleased: deleting.bytes });
}

function requireAdmin(request, env) {
  const expected = env.ALBUM_ADMIN_TOKEN;
  const provided = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1] || '';
  if (!expected || !constantTimeEqual(provided, expected)) {
    throw new AlbumError(403, 'ADMIN_REQUIRED', 'Esta acción requiere autorización de administración.');
  }
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function reconcile(env, bucket) {
  await quotaCall(env, 'begin-reconcile', {});
  try {
    let usedBytes = 0;
    let cursor;
    do {
      const listing = await bucket.list({ prefix: EVENT_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const object of listing.objects) usedBytes += object.size;
      const next = listing.truncated ? listing.cursor : undefined;
      if (listing.truncated && (!next || next === cursor)) throw new AlbumError(503, 'LIST_INCOMPLETE', 'No pudimos verificar todo el almacenamiento.');
      cursor = next;
    } while (cursor);

    const items = [];
    let manifestCursor;
    do {
      const listing = await bucket.list({
        prefix: MANIFEST_PREFIX, limit: 1000, include: ['customMetadata'], ...(manifestCursor ? { cursor: manifestCursor } : {})
      });
      for (const object of listing.objects) {
        const manifest = await bucket.get(object.key);
        if (!manifest) continue;
        const data = await manifest.json().catch(() => null);
        if (!data?.record || !UUID.test(data.record.id || '') || !['photo', 'video'].includes(data.record.media_type)) continue;
        const tokenHash = typeof data.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(data.tokenHash)
          ? data.tokenHash : '0'.repeat(64);
        const existingFiles = [];
        for (const file of data.files || []) {
          const info = pathInfo(file.path, data.record.id);
          const stored = await bucket.head(file.path);
          if (stored && stored.size === file.size && stored.httpMetadata?.contentType === file.mime_type
            && stored.customMetadata?.uploadId === data.record.id && info) existingFiles.push(file);
        }
        if (existingFiles.some(file => file.path === data.record.original_path)) {
          items.push({
            id: data.record.id, bytes: existingFiles.reduce((total, file) => total + file.size, 0),
            mediaType: data.record.media_type, tokenHash
          });
        }
      }
      const next = listing.truncated ? listing.cursor : undefined;
      if (listing.truncated && (!next || next === manifestCursor)) throw new AlbumError(503, 'LIST_INCOMPLETE', 'No pudimos verificar todos los recuerdos.');
      manifestCursor = next;
    } while (manifestCursor);

    return await quotaCall(env, 'finish-reconcile', { usedBytes, items });
  } catch (error) {
    await quotaCall(env, 'cancel-reconcile', {}).catch(() => {});
    throw error;
  }
}

async function getFile(request, bucket, path) {
  const info = pathInfo(path);
  const object = await bucket.head(path);
  if (!object) throw new AlbumError(404, 'FILE_NOT_FOUND', 'Este archivo ya no está disponible.');
  const headers = new Headers({
    'Accept-Ranges': 'bytes', 'ETag': object.httpEtag, 'Content-Length': String(object.size),
    'Cache-Control': object.httpMetadata?.cacheControl || 'public, max-age=31536000, immutable'
  });
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', info.type);
  headers.set('Last-Modified', object.uploaded.toUTCString());
  const downloadName = new URL(request.url).searchParams.get('download');
  headers.set('Content-Disposition', disposition(downloadName ? 'attachment' : 'inline', downloadName || path.split('/').pop()));
  if (request.headers.get('If-None-Match')?.split(',').map(value => value.trim())
    .some(value => value === '*' || value === object.httpEtag || value === 'W/' + object.httpEtag)) {
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') return new Response(null, { headers });

  const rangeValue = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  let range;
  if (rangeValue && (!ifRange || ifRange === object.httpEtag
    || (!ifRange.startsWith('"') && Date.parse(ifRange) >= Math.floor(object.uploaded.getTime() / 1000) * 1000))) {
    const match = rangeValue.match(/^bytes=(\d*)-(\d*)$/);
    let start, end;
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, object.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), object.size - 1) : object.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= object.size) {
      headers.set('Content-Range', 'bytes */' + object.size);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    range = { offset: start, length: end - start + 1 };
    headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + object.size);
    headers.set('Content-Length', String(range.length));
  }
  const file = await bucket.get(path, range ? { range } : undefined);
  if (!file) throw new AlbumError(404, 'FILE_NOT_FOUND', 'Este archivo ya no está disponible.');
  return new Response(file.body, { status: range ? 206 : 200, headers });
}

function disposition(mode, rawName) {
  const name = cleanHeaderFileName(rawName);
  const fallback = name.replace(/[^\x20-\x7e]|["\\;]/g, '_') || 'recuerdo';
  return mode + '; filename="' + fallback + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

function cleanHeaderFileName(value) {
  return String(value || 'recuerdo').replace(/[\/\\\u0000-\u001f\u007f]/g, '_').trim().slice(0, 180) || 'recuerdo';
}

function sqlRows(sql, statement, ...values) { return sql.exec(statement, ...values).toArray(); }
