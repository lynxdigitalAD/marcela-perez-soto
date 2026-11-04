(() => {
  const backdrop = document.getElementById('desktopBackdrop');
  if (!backdrop) return;

  const layers = Array.from(backdrop.querySelectorAll('img'));
  const wideScreen = window.matchMedia('(min-width: 900px)');
  const sections = [
    document.getElementById('portada'),
    ...Array.from(document.querySelectorAll('#contenido-invitacion > .invitation-section')),
  ].filter(Boolean);

  let activeLayer = -1;
  let activeSource = '';
  let pendingSource = '';
  let requestId = 0;
  let framePending = false;

  const discardPendingSource = () => {
    if (!pendingSource) return;
    requestId += 1;
    pendingSource = '';
    const pendingLayer = layers[activeLayer === 0 ? 1 : 0];
    pendingLayer.onload = null;
    pendingLayer.onerror = null;
  };

  const imageForSection = (section) => section.matches('.cover')
    ? section.querySelector('.cover__image')
    : section.querySelector(':scope > picture > img.invitation-image')
      || section.querySelector(':scope > img.invitation-image')
      || section.querySelector('.memories__background');

  const sectionAtViewportCenter = () => {
    const midpoint = window.innerHeight / 2;
    let nearest = sections[0];
    let nearestDistance = Infinity;

    for (const section of sections) {
      const bounds = section.getBoundingClientRect();
      if (bounds.top <= midpoint && bounds.bottom >= midpoint) return section;

      const distance = Math.min(Math.abs(bounds.top - midpoint), Math.abs(bounds.bottom - midpoint));
      if (distance < nearestDistance) {
        nearest = section;
        nearestDistance = distance;
      }
    }

    return nearest;
  };

  const showSource = (source) => {
    if (!wideScreen.matches || !source) return;
    if (source === activeSource) {
      discardPendingSource();
      return;
    }
    if (source === pendingSource) return;

    const nextLayerIndex = activeLayer === 0 ? 1 : 0;
    const nextLayer = layers[nextLayerIndex];
    const thisRequest = ++requestId;
    pendingSource = source;
    const finishLoad = () => {
      if (thisRequest !== requestId || !nextLayer.naturalWidth) return;
      if (activeLayer !== -1) layers[activeLayer].classList.remove('is-active');
      nextLayer.classList.add('is-active');
      activeLayer = nextLayerIndex;
      activeSource = source;
      pendingSource = '';
      nextLayer.onload = null;
      nextLayer.onerror = null;
    };

    nextLayer.onload = finishLoad;
    nextLayer.onerror = () => {
      if (thisRequest === requestId) {
        pendingSource = '';
        nextLayer.onload = null;
        nextLayer.onerror = null;
      }
    };
    nextLayer.src = source;
    if (nextLayer.complete && nextLayer.naturalWidth) finishLoad();
  };

  const update = () => {
    framePending = false;
    if (!wideScreen.matches) return;

    const currentSection = sectionAtViewportCenter();
    const image = imageForSection(currentSection);
    if (image) showSource(image.currentSrc || image.src);
  };

  const scheduleUpdate = () => {
    if (framePending) return;
    framePending = true;
    window.requestAnimationFrame(update);
  };

  const syncBackdropTracking = () => {
    if (wideScreen.matches) {
      window.addEventListener('scroll', scheduleUpdate, { passive: true });
      window.addEventListener('resize', scheduleUpdate, { passive: true });
      scheduleUpdate();
      return;
    }

    window.removeEventListener('scroll', scheduleUpdate);
    window.removeEventListener('resize', scheduleUpdate);
  };

  wideScreen.addEventListener('change', syncBackdropTracking);
  syncBackdropTracking();
})();
