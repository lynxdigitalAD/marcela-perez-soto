(() => {
  const values = {
    days: document.getElementById('countdownDays'),
    hours: document.getElementById('countdownHours'),
    minutes: document.getElementById('countdownMinutes'),
    seconds: document.getElementById('countdownSeconds'),
  };

  if (Object.values(values).some((element) => !element)) return;

  // 5 de diciembre de 2026, 15:00 en America/Mexico_City (UTC−06:00).
  // Epoch UTC evita que la zona horaria configurada en el dispositivo altere el objetivo.
  const targetTime = Date.UTC(2026, 11, 5, 21, 0, 0);

  const updateValue = (element, value) => {
    if (element.textContent === value) return;
    element.classList.remove('is-changing');
    element.textContent = value;
    requestAnimationFrame(() => {
      if (element.isConnected && element.textContent === value) element.classList.add('is-changing');
    });
  };

  let timer = null;
  const updateCountdown = () => {
    const totalSeconds = Math.max(0, Math.floor((targetTime - Date.now()) / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    updateValue(values.days, String(days));
    updateValue(values.hours, String(hours).padStart(2, '0'));
    updateValue(values.minutes, String(minutes).padStart(2, '0'));
    updateValue(values.seconds, String(seconds).padStart(2, '0'));

    if (totalSeconds === 0 && timer !== null) window.clearInterval(timer);
  };

  updateCountdown();
  if (Date.now() < targetTime) timer = window.setInterval(updateCountdown, 1000);

  const refreshCountdownWhenVisible = () => {
    if (!document.hidden) updateCountdown();
  };
  document.addEventListener('visibilitychange', refreshCountdownWhenVisible);
  window.addEventListener('pageshow', refreshCountdownWhenVisible);
})();
