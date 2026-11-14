// Keyboard (arrows / WASD, diagonals), on-screen D-pad, swipe gestures.
const KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, 1], KeyW: [0, 1],
  ArrowDown: [0, -1], KeyS: [0, -1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};

export function installInput(el: HTMLElement, onDir: (heading: number) => void) {
  const held = new Set<string>();
  const emit = () => {
    let x = 0;
    let y = 0;
    for (const k of held) {
      x += KEYS[k][0];
      y += KEYS[k][1];
    }
    if (x === 0 && y === 0) return;
    onDir(((Math.atan2(x, y) * 180) / Math.PI + 360) % 360);
  };
  window.addEventListener('keydown', (ev) => {
    if (!(ev.code in KEYS) || (ev.target as HTMLElement)?.tagName === 'INPUT') return;
    ev.preventDefault();
    if (ev.repeat) return;
    held.add(ev.code);
    emit();
  });
  window.addEventListener('keyup', (ev) => held.delete(ev.code));
  window.addEventListener('blur', () => held.clear());

  document.querySelectorAll<HTMLButtonElement>('#dpad button').forEach((b) =>
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      onDir(Number(b.dataset.h));
    }),
  );

  // swipe = direction (a quick flick; slow drags stay map pans)
  let sx = 0;
  let sy = 0;
  let st = 0;
  el.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length !== 1) return;
      sx = ev.touches[0].clientX;
      sy = ev.touches[0].clientY;
      st = performance.now();
    },
    { capture: true, passive: true },
  );
  el.addEventListener(
    'touchend',
    (ev) => {
      const t = ev.changedTouches[0];
      if (!t || performance.now() - st > 350) return;
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (Math.hypot(dx, dy) < 40) return;
      onDir(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
    },
    { capture: true, passive: true },
  );
}
