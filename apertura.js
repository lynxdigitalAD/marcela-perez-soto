(() => {
  const root = document.documentElement;
  const body = document.body;
  const cover = document.getElementById('portada');
  const openButton = document.getElementById('openInvitation');
  const invitationContent = document.getElementById('contenido-invitacion');
  const nextSection = document.getElementById('presentacion');
  const audio = document.getElementById('invitationMusic');
  const musicControl = document.getElementById('musicControl');
  const invitationImages = invitationContent.querySelectorAll('.invitation-image');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isPageReload = performance.getEntriesByType('navigation')[0]?.type === 'reload';
  let musicHasStarted = false;

  const setMusicPlaying = (isPlaying) => {
    musicControl.classList.toggle('is-playing', isPlaying);
    musicControl.setAttribute('aria-label', isPlaying ? 'Pausar música' : 'Reproducir música');
    musicControl.setAttribute('aria-pressed', String(isPlaying));
  };

  const playMusic = () => {
    const playback = audio.play();
    if (playback && typeof playback.then === 'function') {
      playback.then(() => { musicHasStarted = true; }).catch((error) => {
        console.warn('No se pudo iniciar el audio:', error);
      });
    } else {
      musicHasStarted = true;
    }
  };

  audio.addEventListener('playing', () => setMusicPlaying(true));
  audio.addEventListener('pause', () => setMusicPlaying(false));
  musicControl.addEventListener('click', () => {
    if (audio.paused) playMusic();
    else audio.pause();
  });
  const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.12 })
    : null;

  const isLocked = () => root.classList.contains('is-locked');

  if (isPageReload) {
    // A main-page reload always starts at the locked cover, including after returning from the album.
    history.scrollRestoration = 'manual';
    if (window.location.hash) {
      history.replaceState(history.state, '', window.location.pathname + window.location.search);
    }
    window.scrollTo(0, 0);
    window.addEventListener('pageshow', () => {
      if (isLocked()) window.scrollTo(0, 0);
    }, { once: true });
  }

  const easeOpeningScroll = (progress) => {
    // Cubic-bezier(0.22, 1, 0.36, 1), solved in x-space for stable timing.
    const x1 = 0.22;
    const y1 = 1;
    const x2 = 0.36;
    const y2 = 1;
    const sample = (a, b, t) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    let low = 0;
    let high = 1;

    for (let i = 0; i < 14; i += 1) {
      const t = (low + high) / 2;
      if (sample(x1, x2, t) < progress) low = t;
      else high = t;
    }

    return sample(y1, y2, (low + high) / 2);
  };

  const scrollToPresentation = () => {
    const startY = window.scrollY;
    const targetY = Math.max(0, Math.round(startY + nextSection.getBoundingClientRect().top));
    const duration = reduceMotion.matches ? 0 : 780;

    if (duration === 0 || Math.abs(targetY - startY) < 1) {
      window.scrollTo(0, targetY);
      finishOpening();
      return;
    }

    const startedAt = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = easeOpeningScroll(progress);
      window.scrollTo(0, startY + (targetY - startY) * eased);

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        window.scrollTo(0, targetY);
        finishOpening();
      }
    };

    requestAnimationFrame(step);
  };

  const finishOpening = () => {
    root.classList.remove('is-opening');
    body.classList.remove('is-opening');
    root.classList.add('is-open');
    body.classList.add('is-open');
  };

  const preventScroll = (event) => {
    if (isLocked()) event.preventDefault();
  };

  const unlockPageScroll = () => {
    const restoreY = window.scrollY;

    root.classList.remove('is-locked');
    body.classList.remove('is-locked');

    root.style.overflowY = 'auto';
    root.style.height = 'auto';
    root.style.touchAction = 'pan-y';
    body.style.overflowY = 'auto';
    body.style.position = '';
    body.style.top = '';
    body.style.left = '';
    body.style.right = '';
    body.style.width = '';
    body.style.height = 'auto';
    body.style.inset = 'auto';
    body.style.touchAction = 'pan-y';
    body.style.webkitOverflowScrolling = 'touch';

    document.removeEventListener('wheel', preventScroll);
    document.removeEventListener('touchmove', preventScroll);
    document.removeEventListener('dragstart', preventScroll);
    window.scrollTo(0, restoreY);
  };

  document.addEventListener('wheel', preventScroll, { passive: false });
  document.addEventListener('touchmove', preventScroll, { passive: false });
  document.addEventListener('dragstart', preventScroll);

  document.addEventListener('keydown', (event) => {
    if (!isLocked()) return;

    if (event.key === 'Tab') {
      event.preventDefault();
      openButton.focus({ preventScroll: true });
      return;
    }

    const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
    const spaceOutsideButton = event.code === 'Space' && event.target !== openButton;
    if (scrollKeys.includes(event.key) || spaceOutsideButton) event.preventDefault();
  }, true);

  openButton.addEventListener('click', () => {
    if (!root.classList.contains('is-locked')) return;

    // Start playback synchronously within the first user gesture for browser autoplay policies.
    if (!musicHasStarted) playMusic();

    openButton.disabled = true;
    cover.classList.add('cover--opening');
    unlockPageScroll();
    root.classList.add('is-opening');
    body.classList.add('is-opening');
    invitationContent.inert = false;
    invitationContent.removeAttribute('aria-hidden');
    nextSection.focus({ preventScroll: true });

    if (revealObserver) invitationImages.forEach((image) => revealObserver.observe(image));
    else invitationImages.forEach((image) => image.classList.add('is-visible'));

    scrollToPresentation();
  }, { once: true });

  // Returning from the album should land on its invitation section, unlocked.
  if (!isPageReload && window.location.hash === '#comparte-tus-momentos') {
    openButton.disabled = true;
    unlockPageScroll();
    invitationContent.inert = false;
    invitationContent.removeAttribute('aria-hidden');
    invitationImages.forEach((image) => image.classList.add('is-visible'));
    finishOpening();
    requestAnimationFrame(() => {
      const memories = document.getElementById('comparte-tus-momentos');
      memories.scrollIntoView({ block: 'start' });
      memories.focus({ preventScroll: true });
    });
  }
})();
