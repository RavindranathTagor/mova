import { useEffect, useState } from 'react';
import { Player } from '@remotion/player';
import AvatarMotion from './AvatarMotion';

export default function Avatar({ state = 'idle', size = 80 }: { state?: string; size?: number }) {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const label = `MOVA ${state.toLowerCase().replaceAll('_', ' ')}`;
  return <Player
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
}
