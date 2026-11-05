(() => {
  const root = document.documentElement;
  const body = document.body;
  const cover = document.getElementById('portada');
  const coverImage = cover.querySelector('.cover__image');
  const openButton = document.getElementById('openInvitation');
  const invitationContent = document.getElementById('contenido-invitacion');
  const nextSection = document.getElementById('presentacion');
  const audio = document.getElementById('invitationMusic');
  const musicControl = document.getElementById('musicControl');
  const invitationImages = invitationContent.querySelectorAll('.invitation-image');
  const lazyInvitationImages = document.querySelectorAll('.section-divider img[loading="lazy"], #contenido-invitacion img[loading="lazy"]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isSmallScreen = window.matchMedia('(max-width: 699px)').matches;
  const navigationType = performance.getEntriesByType('navigation')[0]?.type;
  const isPageReload = navigationType === 'reload';
  const isBackForwardNavigation = navigationType === 'back_forward';
  const motionSections = [cover, ...invitationContent.querySelectorAll('.invitation-section')];
  const openingCriticalImages = Array.from(invitationContent.querySelectorAll('.invitation-section'))
    .slice(0, 2)
    .flatMap((section) => Array.from(section.querySelectorAll('img[loading="lazy"]'))
      .filter((image) => !image.closest('.section-divider')));
  const motionObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle('is-motion-active', entry.isIntersecting);
      }
    }, { rootMargin: '200px 0px', threshold: 0 })
    : null;
  if (motionObserver) motionSections.forEach((section) => motionObserver.observe(section));
  else motionSections.forEach((section) => section.classList.add('is-motion-active'));
  let musicHasStarted = false;
  let cancelOpeningScroll = () => {};
  let openingScrollFinished = false;

  const revealCoverImage = () => cover.classList.remove('cover--loading');
  if (coverImage.complete && coverImage.naturalWidth > 0) revealCoverImage();
  else {
    cover.classList.add('cover--loading');
    coverImage.addEventListener('load', revealCoverImage, { once: true });
  }

  let invitationHasOpened = false;
  const firstSectionImage = nextSection.querySelector('img.invitation-image');
  const prefetchFirstSection = () => {
    if (!firstSectionImage || invitationHasOpened || firstSectionImage.complete) return;
    firstSectionImage.loading = 'eager';
    if ('fetchPriority' in firstSectionImage) firstSectionImage.fetchPriority = 'low';
  };
  const scheduleFirstSectionPrefetch = () => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(prefetchFirstSection, { timeout: 1600 });
    } else {
      window.setTimeout(prefetchFirstSection, 650);
    }
  };
  const restoresOpenInvitation = window.location.hash === '#comparte-tus-momentos'
    || isBackForwardNavigation;
  if (!restoresOpenInvitation) {
    if (coverImage.complete && coverImage.naturalWidth > 0) scheduleFirstSectionPrefetch();
    else coverImage.addEventListener('load', scheduleFirstSectionPrefetch, { once: true });
  }

  const setMusicPlaying = (isPlaying) => {
    musicControl.classList.toggle('is-playing', isPlaying);
    musicControl.setAttribute('aria-label', isPlaying ? 'Pausar música' : 'Reproducir música');
    musicControl.setAttribute('aria-pressed', String(isPlaying));
  };

  const playMusic = () => {
    try {
      const playback = audio.play();
      if (playback && typeof playback.then === 'function') {
        playback.then(() => {
          if (!audio.paused) musicHasStarted = true;
          setMusicPlaying(!audio.paused);
        }).catch(() => {
          setMusicPlaying(false);
        });
      } else {
        musicHasStarted = !audio.paused;
        setMusicPlaying(!audio.paused);
      }
    } catch {
      setMusicPlaying(false);
    }
  };

  audio.addEventListener('playing', () => {
    musicHasStarted = true;
    setMusicPlaying(true);
  });
  audio.addEventListener('pause', () => setMusicPlaying(false));
  audio.addEventListener('error', () => setMusicPlaying(false));
  musicControl.addEventListener('click', () => {
    if (root.classList.contains('is-locked')) return;
    if (audio.paused) playMusic();
    else audio.pause();
  });
  const preloadObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = entry.target;
        image.loading = 'eager';
        if ('fetchPriority' in image) {
          const bounds = image.getBoundingClientRect();
          const distance = Math.max(0, bounds.top - window.innerHeight, -bounds.bottom);
          image.fetchPriority = distance <= 350 ? 'high' : 'low';
        }
        observer.unobserve(image);
      }
    }, { rootMargin: isSmallScreen ? '2200px 0px' : '2500px 0px', threshold: 0 })
    : null;

  const priorityObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = entry.target;
        image.loading = 'eager';
        if ('fetchPriority' in image) image.fetchPriority = 'high';
        observer.unobserve(image);
      }
    }, { rootMargin: '900px 0px', threshold: 0 })
    : null;

  const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '1800px 0px', threshold: 0 })
    : null;

  const observeInvitationMedia = () => {
    if (preloadObserver) lazyInvitationImages.forEach((image) => preloadObserver.observe(image));
    if (priorityObserver) lazyInvitationImages.forEach((image) => priorityObserver.observe(image));
    if (revealObserver) invitationImages.forEach((image) => revealObserver.observe(image));
    else invitationImages.forEach((image) => image.classList.add('is-visible'));
  };

  const isLocked = () => root.classList.contains('is-locked');

  if (isPageReload) {
    // A main-page reload always starts at the locked cover, including after returning from the album.
    history.scrollRestoration = 'manual';
    if (window.location.hash) {
      history.replaceState(history.state, '', window.location.pathname + window.location.search);
    }
    window.scrollTo(0, 0);
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
    if (openingScrollFinished) return;

    const startY = window.scrollY;
    const targetY = Math.max(0, Math.round(startY + nextSection.getBoundingClientRect().top));
    if (isSmallScreen) {
      // Avoid consuming the first mobile swipe with an opening animation.
      window.scrollTo(0, targetY);
      finishOpening();
      return;
    }

    const duration = reduceMotion.matches ? 0 : 780;

    if (duration === 0 || Math.abs(targetY - startY) < 1) {
      window.scrollTo(0, targetY);
      finishOpening();
      return;
    }

    const startedAt = performance.now();
    let animationFrame = 0;
    let isAnimating = true;

    const removeScrollIntentListeners = () => {
      window.removeEventListener('wheel', interruptForUserScroll);
      window.removeEventListener('touchstart', interruptForUserScroll);
      window.removeEventListener('pointerdown', interruptForUserScroll);
      document.removeEventListener('keydown', interruptForScrollKey, true);
    };

    const completeAnimation = () => {
      if (!isAnimating) return;
      isAnimating = false;
      cancelOpeningScroll = () => {};
      if (animationFrame) cancelAnimationFrame(animationFrame);
      removeScrollIntentListeners();
      finishOpening();
    };

    cancelOpeningScroll = completeAnimation;

    const interruptForUserScroll = () => completeAnimation();
    const interruptForScrollKey = (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key) || event.code === 'Space') {
        completeAnimation();
      }
    };

    // A guest's scroll gesture takes priority over the brief automatic opening movement.
    window.addEventListener('wheel', interruptForUserScroll, { passive: true });
    window.addEventListener('touchstart', interruptForUserScroll, { passive: true });
    window.addEventListener('pointerdown', interruptForUserScroll, { passive: true });
    document.addEventListener('keydown', interruptForScrollKey, true);

    const step = (now) => {
      animationFrame = 0;
      if (!isAnimating) return;

      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = easeOpeningScroll(progress);
      window.scrollTo(0, startY + (targetY - startY) * eased);

      if (progress < 1) {
        animationFrame = requestAnimationFrame(step);
      } else {
        window.scrollTo(0, targetY);
        completeAnimation();
      }
    };

    animationFrame = requestAnimationFrame(step);
  };

  const finishOpening = () => {
    openingScrollFinished = true;
    history.scrollRestoration = 'auto';
    root.classList.remove('is-opening');
    body.classList.remove('is-opening');
    root.classList.add('is-open');
    body.classList.add('is-open');
  };

  const preventScroll = (event) => {
    if (isLocked()) event.preventDefault();
  };

  const unlockPageScroll = () => {
    root.classList.remove('is-locked');
    body.classList.remove('is-locked');

    document.removeEventListener('wheel', preventScroll);
    document.removeEventListener('touchmove', preventScroll);
    document.removeEventListener('dragstart', preventScroll);
    document.dispatchEvent(new Event('marcela:invitation-opened'));
  };

  const restoreOpenPage = () => {
    invitationHasOpened = true;
    if (root.classList.contains('is-opening')) cancelOpeningScroll();
    openButton.disabled = true;
    unlockPageScroll();
    invitationContent.inert = false;
    invitationContent.removeAttribute('aria-hidden');
    observeInvitationMedia();
    finishOpening();
  };

  const backgroundPage = () => {
    root.classList.add('is-page-backgrounded');
    if (root.classList.contains('is-opening')) cancelOpeningScroll();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) backgroundPage();
    else root.classList.remove('is-page-backgrounded');
  });
  window.addEventListener('pagehide', backgroundPage);
  window.addEventListener('pageshow', () => root.classList.remove('is-page-backgrounded'));

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
    if (!root.classList.contains('is-locked') || invitationHasOpened) return;
    invitationHasOpened = true;

    // Start playback synchronously within the first user gesture for browser autoplay policies.
    if (!musicHasStarted) playMusic();

    openButton.disabled = true;
    cover.classList.add('cover--opening');
    unlockPageScroll();
    root.classList.add('is-opening');
    body.classList.add('is-opening');
    invitationContent.inert = false;
    invitationContent.removeAttribute('aria-hidden');
    openingCriticalImages.forEach((image) => {
      image.loading = 'eager';
      if ('fetchPriority' in image) image.fetchPriority = 'high';
    });
    observeInvitationMedia();

    scrollToPresentation();
  });

  // Returning from the album should land on its invitation section, unlocked.
  if (!isPageReload && window.location.hash === '#comparte-tus-momentos') {
    openButton.disabled = true;
    unlockPageScroll();
    invitationContent.inert = false;
    invitationContent.removeAttribute('aria-hidden');
    invitationImages.forEach((image) => image.classList.add('is-visible'));
    observeInvitationMedia();
    finishOpening();
    document.getElementById('comparte-tus-momentos')
      .scrollIntoView({ block: 'start', behavior: 'auto' });
  } else if (isBackForwardNavigation) {
    restoreOpenPage();
  }
})();
