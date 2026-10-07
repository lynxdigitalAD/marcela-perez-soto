(() => {
  // Coordenadas a las que resuelve el enlace compartido. El botón conserva el enlace original.
  const eventLocation = {
    eventLocationName: '',
    eventAddress: '',
    googleMapsUrl: 'https://maps.app.goo.gl/Pz1jXbxvV7Yn5ojv5',
    googleMapsEmbedUrl: 'https://www.google.com/maps?q=19.4326077,-99.133208&z=17&output=embed',
    eventCoordinates: '19.4326077,-99.133208',
    eventTime: '3:30 P. M.',
  };

  const time = document.getElementById('eventTime');
  const name = document.getElementById('eventLocationName');
  const address = document.getElementById('eventAddress');
  const map = document.getElementById('locationMap');
  const directionsButton = document.getElementById('directionsButton');
  const tabs = [...document.querySelectorAll('#ubicacion [role="tab"]')];
  const locationPanel = document.getElementById('locationPanel');

  if (!time || !name || !address || !map || !directionsButton || !locationPanel || tabs.length === 0) return;

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

  time.textContent = eventLocation.eventTime || '3:30 P. M.';
  name.textContent = eventLocation.eventLocationName.trim() || 'Lugar por confirmar';
  address.textContent = eventLocation.eventAddress.trim();
  address.hidden = !eventLocation.eventAddress.trim();

  const safeMapsUrl = (value) => {
    if (!value) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  };

  const coordinates = eventLocation.eventCoordinates.trim();
  const placeQuery = coordinates || eventLocation.eventAddress.trim();
  const directionsUrl = safeMapsUrl(eventLocation.googleMapsUrl)
    || safeMapsUrl(eventLocation.googleMapsEmbedUrl)
    || (placeQuery ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(placeQuery)}` : '');

  if (directionsUrl) {
    directionsButton.disabled = false;
    directionsButton.addEventListener('click', () => window.open(directionsUrl, '_blank', 'noopener,noreferrer'));
  }

  const embedUrl = safeMapsUrl(eventLocation.googleMapsEmbedUrl);
  if (embedUrl) {
    const iframe = document.createElement('iframe');
    iframe.src = embedUrl;
    iframe.title = eventLocation.eventLocationName
      ? `Mapa de ${eventLocation.eventLocationName}`
      : 'Mapa de la ubicación del evento';
    iframe.loading = 'lazy';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    iframe.allowFullscreen = true;
    map.replaceChildren(iframe);
  }

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
