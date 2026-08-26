'use client';

/**
 * RotateOverlay — full-screen prompt shown on portrait touch devices.
 *
 * Fighting games need landscape orientation for proper gameplay.
 * On phones held in portrait, this overlay asks the user to rotate.
 * Once they rotate, the overlay disappears (CSS media query handles it).
 *
 * The overlay is rendered always when isTouch=true, but CSS only
 * displays it when (orientation: portrait) and (pointer: coarse).
 */
export default function RotateOverlay() {
  return (
    <div className="rotate-overlay" aria-live="polite">
      <div className="rotate-overlay__icon" aria-hidden="true">📱</div>
      <div className="rotate-overlay__text">
        <h2>ROTATE YOUR DEVICE</h2>
        <p>This game is best played in landscape mode.</p>
        <p className="rotate-overlay__hint">Turn your phone sideways to continue.</p>
      </div>
    </div>
  );
}
