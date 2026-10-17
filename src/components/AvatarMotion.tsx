import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame } from 'remotion';

const poseFrames: Record<string, number[]> = {
  restful: [8], idle: [0, 0, 0, 0, 1, 0], detected: [0, 1, 0], mission_created: [0, 1, 0],
  building_context: [5, 5, 6, 5], investigating: [5, 6, 5, 1], planning: [9, 9, 10, 9],
  policy_check: [0, 1, 0], awaiting_approval: [0, 1, 0], executing: [5, 5, 6, 5],
  verifying: [2, 0, 2], resolved: [2, 11, 2, 10], warning: [4, 0, 4], blocked: [4],
  unknown: [0, 4, 0], failed_retryable: [4, 0, 4], replanning: [9, 10, 9], listening: [3, 3, 0, 3],
};

const expressionPoseFrames: Record<string, number[]> = {
  restful: [10], idle: [0, 0, 2, 0, 1, 0], detected: [5, 0, 5], mission_created: [7, 0, 7],
  building_context: [4, 4, 5, 4], investigating: [4, 5, 4, 1], planning: [2, 2, 3, 2],
  policy_check: [3, 1, 3], awaiting_approval: [2, 1, 2], executing: [4, 4, 5, 4],
  verifying: [5, 0, 5], resolved: [6, 8, 6, 15], warning: [3, 0, 3], blocked: [3],
  unknown: [1, 3, 1], failed_retryable: [3, 1, 3], replanning: [2, 3, 2], listening: [14, 1, 14],
};

export default function AvatarMotion({ state = 'idle', expression, expressionGallery = false }: { state?: string; expression?: number; expressionGallery?: boolean }) {
  const frame = useCurrentFrame();
  const poses = expressionGallery ? expressionPoseFrames : poseFrames;
  const frames = poses[state.toLowerCase()] ?? poses.idle;
  const pose = expression ?? frames[Math.floor(frame / 24) % frames.length];
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
        backgroundImage: `url("${staticFile(expressionGallery ? 'images/avatars/mova-avatar-expressions.jpeg' : 'Avatar.png')}")`,
        backgroundSize: expressionGallery ? '400% 400%' : '400% 300%',
        backgroundPosition: `${(pose % 4) * 100 / 3}% ${Math.floor(pose / 4) * (expressionGallery ? 100 / 3 : 50)}%`,
        backgroundRepeat: 'no-repeat',
        transform: `translateY(${bob + lift}px)`,
        transformOrigin: '50% 75%',
      }}
    />
  </AbsoluteFill>;
}
