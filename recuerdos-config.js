window.MARCELA_RECUERDOS_CONFIG = {
  storage: {
    provider: 'cloudflare-r2',
    // The invitation source is still local; this endpoint is already deployed.
    apiBaseUrl: 'https://marcela-recuerdos-api.lynxdigitalad.workers.dev'
  },
  paths: {
    photos: 'marcela-98',
    originalsVideos: 'marcela-98/videos',
    thumbnailsVideos: 'marcela-98/thumbnails'
  },
  maxPhotoProcessedSize: 50 * 1024 * 1024,
  maxPhotoInputSize: 50 * 1024 * 1024,
  maxVideoSize: 250 * 1024 * 1024,
  optimizedMaxDimension: 1600,
  webpQuality: 0.82,
  thumbnailMaxDimension: 480,
  thumbnailQuality: 0.76,
  pageSize: 10
};
