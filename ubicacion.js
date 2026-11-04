(() => {
  const eventLocations = {
    fiesta: {
      name: 'Salón MC',
      address: '3a Adolfo López Mateos 4, Medias Tierras, 43698 Tulancingo, Hgo.',
      mapsUrl: 'https://maps.app.goo.gl/q2vhdzTr7PithSEJ8?g_st=iw',
      mapQuery: 'Salón MC, 3a Adolfo López Mateos 4, Medias Tierras, 43698 Tulancingo, Hgo.',
      dateTime: '5 de diciembre · 3:00 p. m.',
    },
    misa: {
      name: 'Parroquia de la Santísima Trinidad',
      address: 'C. Petr Tchaikovsky, Jardines del Sur 4ta Secc, 43660 Tulancingo, Hgo.',
      mapsUrl: 'https://maps.app.goo.gl/fyvmi3VPmndbYeD26?g_st=iw',
      mapQuery: 'Parroquia de la Santísima Trinidad, C. Petr Tchaikovsky, Jardines del Sur 4ta Secc, 43660 Tulancingo, Hgo.',
      dateTime: '6 de diciembre · 1:00 p. m.',
    },
  };

  const time = document.getElementById('eventTime');
  const name = document.getElementById('eventLocationName');
  const address = document.getElementById('eventAddress');
  const map = document.getElementById('locationMap');
  const directionsButton = document.getElementById('directionsButton');
  const tabs = [...document.querySelectorAll('#ubicacion [role="tab"]')];
  const locationPanel = document.getElementById('locationPanel');

  if (!time || !name || !address || !map || !directionsButton || !locationPanel || tabs.length === 0) return;

  const safeMapsUrl = (value) => {
    if (!value) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  };

  const showLocation = (location) => {
    if (!location) return;

    name.textContent = location.name;
    time.textContent = location.dateTime;
    address.textContent = location.address;
    address.hidden = !location.address;

    directionsButton.disabled = !safeMapsUrl(location.mapsUrl);

    const embedUrl = safeMapsUrl(
      `https://www.google.com/maps?q=${encodeURIComponent(location.mapQuery)}&z=17&output=embed`,
    );
    if (!embedUrl) {
      map.replaceChildren();
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.src = embedUrl;
    iframe.title = `Mapa de ${location.name}`;
    iframe.loading = 'lazy';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    iframe.allowFullscreen = true;
    map.replaceChildren(iframe);
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
    map.setAttribute('aria-label', `Mapa de ${activeTab.textContent.trim().toLocaleLowerCase('es-MX')}`);
    showLocation(eventLocations[activeTab.dataset.eventLocation]);
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
  selectTab(Math.max(0, tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')));

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
