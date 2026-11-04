(() => {
  class SectionDivider extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount) return;

      const picture = document.createElement('picture');
      const webp = document.createElement('source');
      webp.type = 'image/webp';
      webp.srcset = 'assets/separador-vaquero-marcela-800w.webp 800w, assets/separador-vaquero-marcela-1200w.webp 1200w, assets/separador-vaquero-marcela.webp 2172w';
      webp.sizes = '(min-width: 900px) 585px, (min-width: 700px) 780px, 100vw';

      const image = document.createElement('img');
      image.srcset = 'assets/separador-vaquero-marcela-800w.png 800w, assets/separador-vaquero-marcela-1200w.png 1200w, assets/separador-vaquero-marcela.png 2172w';
      image.sizes = '(min-width: 900px) 585px, (min-width: 700px) 780px, 100vw';
      image.src = 'assets/separador-vaquero-marcela.png';
      image.alt = '';
      image.setAttribute('aria-hidden', 'true');
      image.draggable = false;
      image.width = 2172;
      image.height = 724;
      image.loading = 'lazy';
      image.decoding = 'async';
      picture.append(webp, image);
      this.append(picture);
    }
  }

  if (!customElements.get('section-divider')) {
    customElements.define('section-divider', SectionDivider);
  }

  const cover = document.getElementById('portada');
  const content = document.getElementById('contenido-invitacion');
  if (!cover || !content) return;
  const createDivider = () => {
    const divider = document.createElement('section-divider');
    divider.classList.add('section-divider');
    return divider;
  };

  const reconcile = () => {
    const sections = [cover, ...Array.from(content.children)
      .filter((element) => element.classList.contains('invitation-section'))];

    sections.forEach((section, index) => {
      section.style.setProperty('--section-stack', String(sections.length - index));
      const dividers = Array.from(section.children).filter((child) => child.localName === 'section-divider');

      if (index < sections.length - 1) {
        if (dividers.length === 0) section.append(createDivider());
        dividers.slice(1).forEach((divider) => divider.remove());
      } else {
        dividers.forEach((divider) => divider.remove());
      }
    });
  };

  reconcile();

  if ('MutationObserver' in window) {
    const sectionsObserver = new MutationObserver(reconcile);
    sectionsObserver.observe(content, { childList: true });
  }
})();
