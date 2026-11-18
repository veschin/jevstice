let stopActive = null;

for (const controls of document.querySelectorAll('.replay-controls')) {
  const image = controls.previousElementSibling;
  const still = image.getAttribute('src');
  const button = document.createElement('button');
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  button.type = 'button';
  button.textContent = 'Play GIF';
  controls.prepend(button);
  controls.append(status);

  function stop() {
    stopActive = null;
    image.src = still;
    button.textContent = 'Play GIF';
    status.textContent = '';
  }

  button.addEventListener('click', () => {
    if (stopActive === stop) {
      stop();
      return;
    }
    stopActive?.();
    stopActive = stop;
    image.src = still.replace(/\.png$/, '.gif');
    button.textContent = 'Stop GIF';
    status.textContent = 'Loading replay...';
  });

  image.addEventListener('load', () => {
    if (stopActive === stop) status.textContent = '';
  });

  image.addEventListener('error', () => {
    if (stopActive !== stop) return;
    stop();
    status.textContent = 'Replay unavailable. Read the extract for the recorded result.';
  });
}
