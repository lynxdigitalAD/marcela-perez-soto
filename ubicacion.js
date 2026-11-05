(() => {
  const eventLocations = {
    fiesta: {
      name: 'Salón MC',
      address: '3a Adolfo López Mateos 4, Medias Tierras, 43698 Tulancingo, Hgo.',
      mapsUrl: 'https://maps.app.goo.gl/q2vhdzTr7PithSEJ8?g_st=iw',
      mapQuery: 'Salón MC, 3a Adolfo López Mateos 4, Medias Tierras, 43698 Tulancingo, Hgo.',
      coordinates: [20.0623033, -98.3644019],
      dateTime: '5 de diciembre · 3:00 p. m.',
    },
    misa: {
      name: 'Parroquia de la Santísima Trinidad',
      address: 'C. Petr Tchaikovsky, Jardines del Sur 4ta Secc, 43660 Tulancingo, Hgo.',
      mapsUrl: 'https://maps.app.goo.gl/fyvmi3VPmndbYeD26?g_st=iw',
      mapQuery: 'Parroquia de la Santísima Trinidad, C. Petr Tchaikovsky, Jardines del Sur 4ta Secc, 43660 Tulancingo, Hgo.',
      coordinates: [20.0707841, -98.374086],
      dateTime: '6 de diciembre · 1:00 p. m.',
    },
  };

  const time = document.getElementById('eventTime');
  const name = document.getElementById('eventLocationName');
  const address = document.getElementById('eventAddress');
  const mapElement = document.getElementById('locationMap');
  const directionsButton = document.getElementById('directionsButton');
  const tabs = [...document.querySelectorAll('#ubicacion [role="tab"]')];
  const locationPanel = document.getElementById('locationPanel');
  const leafletStylesheet = document.querySelector('link[href*="assets/leaflet/leaflet.css"]');

  if (!time || !name || !address || !mapElement || !directionsButton || !locationPanel || tabs.length === 0) return;

  const safeMapsUrl = (value) => {
    if (!value) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  };

  const hasLeafletStyles = () => {
    if (!leafletStylesheet?.sheet) return false;
    try {
      return leafletStylesheet.sheet.cssRules.length > 0;
    } catch {
      return false;
    }
  };

  let activeLocationKey = '';
  let leafletMap = null;
  let locationMarker = null;
  let tileLayer = null;
  let tilesAdded = false;
  let resizeObserver = null;
  let mapStatus = null;
  let tileLoadCount = 0;
  let tileErrorCount = 0;
  let tileLoadTimeout = 0;

  const setMapUnavailable = (unavailable) => {
    if (!mapStatus && !unavailable) return;
    if (!mapStatus) {
      mapStatus = document.createElement('p');
      mapStatus.className = 'location__map-status';
      mapStatus.setAttribute('role', 'status');
      mapStatus.setAttribute('aria-live', 'polite');
      mapStatus.textContent = 'El mapa no está disponible ahora. Usa «Abrir en Maps» para ver la ubicación.';
    }
    if (!mapStatus.isConnected) mapElement.append(mapStatus);
    mapStatus.hidden = !unavailable;
  };

  const updateMarker = (location) => {
    if (!locationMarker) return;
    const popupLabel = document.createElement('span');
    popupLabel.textContent = location.name;
    locationMarker.setLatLng(location.coordinates);
    locationMarker.setPopupContent(popupLabel);
    locationMarker.options.title = location.name;
    const markerElement = locationMarker.getElement();
    if (markerElement) {
      markerElement.title = location.name;
      markerElement.setAttribute('aria-label', `Ubicación: ${location.name}`);
    }
  };

  const showLocation = (locationKey) => {
    const location = eventLocations[locationKey];
    if (!location) return;

    activeLocationKey = locationKey;
    name.textContent = location.name;
    time.textContent = location.dateTime;
    address.textContent = location.address;
    address.hidden = !location.address;
    directionsButton.disabled = !safeMapsUrl(location.mapsUrl);

    if (!leafletMap) return;
    updateMarker(location);
    leafletMap.setView(location.coordinates, 17, { animate: false });
    requestMapResize();
  };

  let resizeFrame = 0;
  const requestMapResize = () => {
    if (!leafletMap || resizeFrame || !mapElement.clientWidth || !mapElement.clientHeight) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      if (mapElement.clientWidth && mapElement.clientHeight) {
        leafletMap?.invalidateSize({ animate: false, pan: false, debounceMoveend: true });
      }
    });
  };

  const loadTiles = () => {
    if (tilesAdded || !leafletMap || !tileLayer) return;
    tilesAdded = true;
    tileLayer.addTo(leafletMap);
    tileLoadTimeout = window.setTimeout(() => {
      if (tileLoadCount === 0) setMapUnavailable(true);
    }, 7000);
    requestMapResize();
  };

  const observeMapApproach = () => {
    if (!('IntersectionObserver' in window)) {
      loadTiles();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      requestMapResize();
      loadTiles();
    }, { rootMargin: '1400px 0px', threshold: 0 });
    observer.observe(mapElement);
  };

  const initializeMap = () => {
    if (leafletMap) return;
    if (!window.L || !hasLeafletStyles()) {
      setMapUnavailable(true);
      return;
    }

    const location = eventLocations[activeLocationKey] || eventLocations.fiesta;
    leafletMap = window.L.map(mapElement, {
      center: location.coordinates,
      zoom: 17,
      minZoom: 5,
      maxZoom: 19,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      keyboard: false,
      zoomControl: false,
      attributionControl: false,
      tap: true,
      worldCopyJump: true,
    });

    window.L.control.zoom({ position: 'bottomleft' }).addTo(leafletMap);
    window.L.control.attribution({ position: 'bottomright', prefix: false }).addTo(leafletMap);

    const popupLabel = document.createElement('span');
    popupLabel.textContent = location.name;
    const markerIcon = window.L.divIcon({
      className: 'location__map-marker',
      html: '<span aria-hidden="true"></span>',
      iconSize: [44, 44],
      iconAnchor: [22, 22],
      popupAnchor: [0, -22],
    });
    locationMarker = window.L.marker(location.coordinates, {
      icon: markerIcon,
      title: location.name,
      alt: location.name,
      keyboard: false,
      autoPanOnFocus: false,
    }).bindPopup(popupLabel).addTo(leafletMap);
    updateMarker(location);

    tileLayer = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      minZoom: 5,
      maxZoom: 19,
      keepBuffer: 1,
      updateWhenIdle: true,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
    });
    tileLayer.on('tileload', () => {
      tileLoadCount += 1;
      tileErrorCount = 0;
      window.clearTimeout(tileLoadTimeout);
      setMapUnavailable(false);
    });
    tileLayer.on('tileerror', () => {
      tileErrorCount += 1;
      if (tileLoadCount === 0 && tileErrorCount >= 3) setMapUnavailable(true);
    });

    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(requestMapResize);
      resizeObserver.observe(mapElement);
    } else {
      window.addEventListener('resize', requestMapResize, { passive: true });
    }

    window.addEventListener('pageshow', requestMapResize, { passive: true });
    window.addEventListener('orientationchange', requestMapResize, { passive: true });
    window.visualViewport?.addEventListener('resize', requestMapResize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) requestMapResize();
    });
    requestMapResize();
    observeMapApproach();

    if ('IntersectionObserver' in window) {
      const visibilityObserver = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        requestMapResize();
      }, { threshold: 0.01 });
      visibilityObserver.observe(mapElement);
    }
  };

  directionsButton.addEventListener('click', () => {
    const activeTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    const location = eventLocations[activeTab?.dataset.eventLocation];
    const mapsUrl = safeMapsUrl(location?.mapsUrl);
    if (mapsUrl) window.open(mapsUrl, '_blank', 'noopener,noreferrer');
  });

  const selectTab = (selectedIndex, moveFocus = false) => {
    tabs.forEach((tab, index) => {
      const selected = index === selectedIndex;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });

    const activeTab = tabs[selectedIndex];
    locationPanel.setAttribute('aria-labelledby', activeTab.id);
    mapElement.setAttribute('aria-label', `Mapa de ${activeTab.textContent.trim().toLocaleLowerCase('es-MX')}`);
    showLocation(activeTab.dataset.eventLocation);
    if (moveFocus) activeTab.focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', (event) => {
      let nextIndex;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;

      event.preventDefault();
      selectTab(nextIndex, true);
    });
  });

  const initialIndex = Math.max(0, tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true'));
  selectTab(initialIndex);

  document.addEventListener('marcela:invitation-opened', initializeMap, { once: true });
  if (!document.documentElement.classList.contains('is-locked')) initializeMap();

  const revealItems = [...document.querySelectorAll('#ubicacion [data-location-reveal]')];
  revealItems.forEach((item, index) => {
    item.style.setProperty('--location-delay', `${index * 105}ms`);
  });

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        revealItems.forEach((item) => item.classList.add('is-visible'));
        observer.disconnect();
        break;
      }
    }, { threshold: 0.1 });
    observer.observe(document.getElementById('ubicacion'));
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }
})();
