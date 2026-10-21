const radians = (degrees) => degrees * Math.PI / 180;

const degrees = (value) => value * 180 / Math.PI;

const turn = (angle) => ((angle + 180) % 360 + 360) % 360 - 180;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const bearing = (a, b) => degrees(Math.atan2(b.y - a.y, b.x - a.x));

const rotate = (x, y, angle) => ({ x: x * Math.cos(radians(angle)) - y * Math.sin(radians(angle)), y: x * Math.sin(radians(angle)) + y * Math.cos(radians(angle)) });

const round = (value) => Math.round(value * 1e7) / 1e7;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function motionTime(motion, time) {
  let t = time;
  if (motion.loop && t > motion.duration) t %= motion.duration;
  return clamp(t, 0, motion.duration);
}

export { bearing, clamp, degrees, distance, motionTime, radians, rotate, round, turn };
