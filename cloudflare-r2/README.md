# Álbum de Marcela: Worker + R2

La experiencia del álbum conserva selección o toma de foto, vista previa, cola de subida, compresión, galería, páginas, visor, reproducción de video, descarga y compartir. El diseño aprobado de la invitación no forma parte de esta migración.

## Arquitectura

```text
Invitación pública → Cloudflare Worker → R2 privado
                                  ↘ Durable Object SQLite (cuota y estado)
```

- Bucket Standard: `lynx-invitaciones-fotos`. No se habilita acceso público ni dominio `r2.dev`.
- Todos los archivos de Marcela se guardan bajo `marcela-98/`: fotos optimizadas en la raíz del prefijo, videos en `videos/` y portadas de video en `thumbnails/`.
- Los nombres de objetos se generan con UUID. Manifiestos y permisos temporales de subida se guardan en prefijos privados fuera de `marcela-98/`.
- El Durable Object `MarcelaAlbumQuota`, identificado por `marcela-98`, reserva espacio de forma atómica y confirma, libera, descuenta y reconcilia bytes. No almacena multimedia.
- Tope compartido: **5,000,000,000 bytes (5 GB)**. Incluye fotos, videos y portadas de video. Si una subida excedería el tope, el álbum indica que ese recuerdo no cabe dentro del límite compartido.
- Fotos: JPG/JPEG, PNG, WebP, HEIC y HEIF, hasta 50 MB por archivo en cualquiera de esos formatos; se optimizan como WebP, JPG o PNG según los formatos de imagen que pueda codificar el navegador, con un máximo de 50 MB para el archivo guardado. Videos: MP4, MOV y WebM, hasta 250 MB por archivo en cualquiera de esos formatos. El video y su portada cuentan juntos para la cuota compartida de 5 GB. Las portadas aceptan WebP, JPG/JPEG o PNG para que la codificación en navegadores móviles no bloquee la subida.
- Los videos de más de 8 MiB se envían al Worker en bloques secuenciales de 8 MiB y se ensamblan con R2 multipart. Así, cada solicitud queda por debajo del límite de cuerpo de Workers y el Worker conserva la validación, autorización y control de cuota del archivo completo.
- El Worker solo permite los orígenes configurados y valida la ruta y firma real de cada archivo. El navegador nunca recibe credenciales de R2 ni el token administrativo.
- Un Cron Trigger ejecuta cada hora (UTC) una limpieza de subidas sin actividad durante 48 horas. Libera reservas abandonadas y archivos parciales; si el recuerdo ya quedó confirmado, solo elimina la sesión temporal y conserva el contenido.

## API

- `GET /health`: proveedor, evento y límites.
- `GET /api/events/marcela-98/memories?page=1`: sirve lotes de 10; la galería los va agregando automáticamente al desplazarse.
- `GET /api/events/marcela-98/photos?page=1`: filtro de fotografías.
- `POST /api/events/marcela-98/uploads`: valida el recuerdo y reserva espacio.
- `PUT /api/events/marcela-98/objects/{ruta}`: escribe un archivo de la reserva.
- `POST /api/events/marcela-98/memories`: publica el recuerdo cuando todos sus archivos están completos.
- `GET|HEAD /media/{ruta}`: sirve contenido privado mediante el Worker; admite descarga, ETag y rangos de video.
- `DELETE /api/events/marcela-98/uploads/{uuid}`: cancela una reserva con el token de esa subida.
- `DELETE /api/events/marcela-98/memories/{uuid}`: eliminación solo con `Authorization: Bearer …` administrativo.
- `GET /api/events/marcela-98/usage` y `POST /api/events/marcela-98/usage/reconcile`: uso interno, protegidos por el mismo token.

No se acepta que el cliente elija un bucket o prefijo. El álbum usa Cloudflare Worker + R2 para archivos y Durable Object SQLite para estados y cuota; no tiene una dependencia de ejecución de Supabase.

## Entornos y pruebas

```powershell
npm ci
npm test
npm run check
npm run dev
```

El servidor de desarrollo usa Miniflare para ejecutar el Worker en `http://127.0.0.1:8787` con R2 y Durable Objects efímeros. La invitación local en `http://127.0.0.1:8765/recuerdos.html` usa la API remota configurada en `recuerdos-config.js`; para apuntarla al emulador, cambia temporalmente `apiBaseUrl` a una cadena vacía. Los tests y el servidor local no escriben en el bucket remoto.

## Estado de Cloudflare

- R2 ya estaba activado en la cuenta conectada.
- `lynx-invitaciones-fotos` se creó en Standard, región `ENAM`, privado; al crearlo contenía 0 objetos y 0 B.
- Se configuraron el binding R2 y la migración SQLite del Durable Object en `wrangler.jsonc`.
- Wrangler tiene el secreto remoto `ALBUM_ADMIN_TOKEN`; el valor local está en `.dev.vars`, ignorado por Git. No guardes el valor en el código ni en el frontend.
- Worker desplegado: `https://marcela-recuerdos-api.lynxdigitalad.workers.dev`. Las URLs de vista previa adicionales están desactivadas.
- `../recuerdos-config.js` apunta a ese Worker. La versión local auditada sigue pendiente de publicación; GitHub Pages aún sirve una versión anterior sin `recuerdos.html` (verificación del 4 de noviembre de 2026). Publica al final, después de revisar esta versión.
- La prueba inicial con navegador y Cloudflare cubrió selección/cámara, preview, WebP, subida, listado de foto/video, visor, descarga, reproducción, refresco, recuperación ante fallo de red, mensajes de formato/tamaño, CORS y responsive. Los tres objetos de esa prueba se borraron mediante el endpoint administrativo y se reconcilió el Durable Object. Después se añadieron recuerdos activos.
- Última lectura de solo consulta, 4 de noviembre de 2026: el Worker lista **4 recuerdos (2 fotos y 2 videos)** y reporta **53,895,051 bytes usados, 0 reservados y sin reconciliación activa**. El panel de R2 muestra **10 objetos y aproximadamente 53.92 MB**; la diferencia pequeña con la cuota del Worker corresponde a objetos internos/metadata y redondeo del panel. Las seis rutas de archivos multimedia y miniaturas respondieron correctamente.
- El proyecto y los datos de Supabase no se modificaron ni borraron. El Worker, el frontend y el almacenamiento activo del álbum no usan Supabase.

El tope de Marcela queda por debajo de los 10 GB-mes incluidos en R2 Standard, siempre que el uso del resto de la cuenta también permanezca dentro de su cuota. No se activó un plan de pago. Las cuotas y costos por volumen de operaciones se describen en [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) y [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Publicación

El Worker se publica por separado con `npx wrangler deploy` desde esta carpeta. La versión nueva de la invitación no debe publicarse en GitHub Pages hasta revisar el álbum en el navegador y confirmar que las pruebas reales de foto y video terminan correctamente.
