import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame } from 'remotion';

const poseFrames: Record<string, number[]> = {
  restful: [8], idle: [0, 0, 0, 0, 1, 0], detected: [0, 1, 0], mission_created: [0, 1, 0],
  building_context: [5, 5, 6, 5], investigating: [5, 6, 5, 1], planning: [9, 9, 10, 9],
  policy_check: [0, 1, 0], awaiting_approval: [0, 1, 0], executing: [5, 5, 6, 5],
  verifying: [2, 0, 2], resolved: [2, 11, 2, 10], warning: [4, 0, 4], blocked: [4],
  unknown: [0, 4, 0], failed_retryable: [4, 0, 4], replanning: [9, 10, 9], listening: [3, 3, 0, 3],
};

export default function AvatarMotion({ state = 'idle' }: { state?: string }) {
  const frame = useCurrentFrame();
  const frames = poseFrames[state.toLowerCase()] ?? poseFrames.idle;
  const pose = frames[Math.floor(frame / 24) % frames.length];
  const bob = Math.sin((frame / 90) * Math.PI * 2) * 1.5;
  const celebratory = state.toLowerCase() === 'resolved';
  const lift = celebratory
    ? interpolate(frame % 90, [0, 12, 28, 45], [0, -7, 0, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.quad) })
    : 0;

  return <AbsoluteFill style={{ overflow: 'hidden' }}>
    <div
      role="img"
      aria-label="Cream-colored MOVA dog wearing its blue cap"
      style={{
        width: '100%', height: '100%',
        backgroundImage: `url("${staticFile('Avatar.png')}")`,
        backgroundSize: '400% 300%',
        backgroundPosition: `${(pose % 4) * 100 / 3}% ${Math.floor(pose / 4) * 50}%`,
        backgroundRepeat: 'no-repeat',
        transform: `translateY(${bob + lift}px)`,
        transformOrigin: '50% 75%',
      }}
    />
  </AbsoluteFill>;
}
