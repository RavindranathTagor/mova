import { useEffect, useRef, useState } from 'react';
import { Player } from '@remotion/player';
import AvatarMotion from './AvatarMotion';
import './Avatar.css';

const expressions = [
  'Welcome', 'Curious', 'Thinking', 'Unsure',
  'Working', 'Surprised', 'Winking', 'Paw up',
  'Celebrating', 'Yawning', 'Sleeping', 'Resting',
  'Ready', 'Playful', 'Listening', 'Paw wave',
];

export default function Avatar({ state = 'idle', size = 80, expressionGallery = false }: { state?: string; size?: number; expressionGallery?: boolean }) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [selectedExpression, setSelectedExpression] = useState<number>();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setSelectedExpression(undefined);
  }, [state]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (galleryOpen && !dialog.open) dialog.showModal();
    if (!galleryOpen && dialog.open) dialog.close();
  }, [galleryOpen]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const label = `MOVA ${state.toLowerCase().replaceAll('_', ' ')}`;
  if (!expressionGallery) return <Player
    component={AvatarMotion}
    inputProps={{ state }}
    durationInFrames={90}
    compositionWidth={160}
    compositionHeight={160}
    fps={30}
    loop
    autoPlay={!reducedMotion}
    clickToPlay={false}
    style={{ width: size, height: size, flex: 'none' }}
    aria-label={label}
    className={`avatar avatar-${state.toLowerCase()}`}
  />;

  return <>
    <button
      type="button"
      className={`avatar avatar-${state.toLowerCase()} avatar-expression-trigger`}
      style={{ width: size, height: size, flex: 'none' }}
      aria-label="Open MOVA puppy expression gallery"
      aria-haspopup="dialog"
      title="Browse puppy expressions"
      onClick={() => setGalleryOpen(true)}
    >
      <Player
        component={AvatarMotion}
        inputProps={{ state, expression: selectedExpression, expressionGallery: true }}
        durationInFrames={90}
        compositionWidth={160}
        compositionHeight={160}
        fps={30}
        loop
        autoPlay={!reducedMotion}
        clickToPlay={false}
        style={{ width: '100%', height: '100%', flex: 'none' }}
        aria-label={label}
        className="avatar-player"
      />
    </button>
    <dialog
      ref={dialogRef}
      className="avatar-expression-dialog"
      aria-labelledby="avatar-expression-title"
      onClose={() => setGalleryOpen(false)}
    >
      <div className="avatar-expression-heading">
        <div>
          <h2 id="avatar-expression-title">MOVA’s expressions</h2>
          <p>Choose an expression to preview.</p>
        </div>
        <button type="button" className="avatar-expression-close" onClick={() => setGalleryOpen(false)}>Close</button>
      </div>
      <div className="avatar-expression-grid">
        {expressions.map((expression, index) => (
          <button
            type="button"
            key={expression}
            className="avatar-expression-option"
            aria-pressed={selectedExpression === index}
            onClick={() => {
              setSelectedExpression(index);
              setGalleryOpen(false);
            }}
          >
            <span
              className="avatar-expression-preview"
              aria-hidden="true"
              style={{
                backgroundPosition: `${(index % 4) * 100 / 3}% ${Math.floor(index / 4) * 100 / 3}%`,
              }}
            />
            <span>{expression}</span>
          </button>
        ))}
      </div>
    </dialog>
  </>;
}
