import { bytesToImageDataURL } from "../../shared/codec/image-data.mjs";
import { magicEffectFrames } from "../../shared/domain/rig-effects.mjs";

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const smooth = (value) => { const x = clamp(value); return x * x * (3 - 2 * x); };
const alpha = (value) => clamp(value).toFixed(4);
function star(ctx, x, y, radius, color, rotation = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rotation); ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4, r = i % 2 ? radius * .2 : radius;
    ctx[i ? "lineTo" : "moveTo"](Math.cos(angle) * r, Math.sin(angle) * r);
  }
  ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.restore();
}
function glow(ctx, x, y, radius, strength) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `rgba(226,255,255,${alpha(strength)})`);
  gradient.addColorStop(.18, `rgba(92,214,255,${alpha(strength * .8)})`);
  gradient.addColorStop(.55, `rgba(36,127,255,${alpha(strength * .36)})`);
  gradient.addColorStop(1, "rgba(28,110,255,0)");
  ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}
function charge(ctx, time, options) {
  const build = smooth((time - options.chargeStart) / (options.releaseTime - options.chargeStart));
  const fade = time <= options.releaseTime ? 1 : clamp(1 - (time - options.releaseTime) / .14);
  const strength = options.intensity * fade * (.12 + .88 * build);
  ctx.save(); ctx.translate(128, 128); ctx.scale(.6 + .4 * build, .6 + .4 * build);
  glow(ctx, 0, 0, 116, strength * .5);
  ctx.globalAlpha = clamp(strength);
  ctx.rotate((time - options.chargeStart) * .9);
  ctx.lineWidth = 2.8; ctx.strokeStyle = "#2782dc"; ctx.shadowColor = "#69dcff"; ctx.shadowBlur = 7;
  ctx.beginPath(); ctx.arc(0, 0, 103, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.1; ctx.strokeStyle = "#92e9ff";
  ctx.beginPath(); ctx.arc(0, 0, 96, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowBlur = 0; ctx.strokeStyle = "#edbf63"; ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    ctx.beginPath(); ctx.arc(0, 0, 80, angle + .08, angle + 1.04); ctx.stroke();
    star(ctx, Math.cos(angle) * 103, Math.sin(angle) * 103, 6.5, "#ffdfa1", angle);
  }
  ctx.strokeStyle = "rgba(85,180,255,.7)"; ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 + Math.PI / 8;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * 77, Math.sin(a) * 77); ctx.lineTo(Math.cos(a) * 96, Math.sin(a) * 96); ctx.stroke();
  }
  for (let i = 0; i < 12; i++) {
    const progress = ((time - options.chargeStart) * 1.7 + i / 12) % 1;
    const angle = i * 2.39996 + time * .6, radius = 112 - 85 * progress, visibility = Math.sin(progress * Math.PI);
    ctx.globalAlpha = clamp(strength * visibility * .85);
    const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
    ctx.strokeStyle = i % 3 ? "#4bb6ff" : "#f3c966"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(Math.cos(angle) * (radius + 9), Math.sin(angle) * (radius + 9)); ctx.stroke();
    star(ctx, x, y, i % 3 ? 2.5 : 4, i % 3 ? "#c1f8ff" : "#ffe4a5");
  }
  ctx.globalAlpha = 1; glow(ctx, 0, 0, 38, strength * .8);
  star(ctx, 0, 0, 13 + 4 * Math.sin(time * 13), `rgba(226,253,255,${alpha(strength * .85)})`, time * .3);
  ctx.restore();
}
function release(ctx, time, options) {
  const age = time - options.releaseTime, duration = options.endTime - options.releaseTime;
  const progress = clamp(age / duration), burst = age < 0 ? smooth((age + .07) / .07) : Math.pow(1 - progress, 1.6);
  const strength = clamp(options.intensity * burst), spread = age < 0 ? .2 + .8 * burst : .9 + .1 * progress;
  ctx.save(); ctx.translate(40, 128); ctx.scale(spread, spread);
  glow(ctx, 42, 0, 73, strength * .72);
  ctx.globalAlpha = strength;
  const fan = ctx.createLinearGradient(0, 0, 207, 0);
  fan.addColorStop(0, "rgba(206,253,255,.95)"); fan.addColorStop(.24, "rgba(43,170,255,.82)"); fan.addColorStop(1, "rgba(38,119,255,.12)");
  ctx.fillStyle = fan; ctx.beginPath();ctx.moveTo(0, 0);ctx.quadraticCurveTo(83, -14, 198, -58);ctx.lineTo(159, 0);ctx.lineTo(207, 62);ctx.quadraticCurveTo(88, 17, 0, 0);ctx.fill();
  for (let i = 0; i < 9; i++) {
    const angle = (i - 4) * .16, length = 111 + (i % 3) * 23 + progress * 28;
    const x = Math.cos(angle) * length, y = Math.sin(angle) * length;
    const stroke = ctx.createLinearGradient(0, 0, x, y);stroke.addColorStop(0, "#e4ffff");stroke.addColorStop(.28, i % 3 ? "#2997eb" : "#e3ae43");stroke.addColorStop(1, "rgba(57,139,255,.15)");
    ctx.strokeStyle = stroke;ctx.lineWidth = i % 3 ? 3 : 2;ctx.beginPath();ctx.moveTo(0, 0);ctx.quadraticCurveTo(x * .55, y * .35, x, y);ctx.stroke();
  }
  ctx.strokeStyle = "#278cdf";ctx.lineWidth = 4;ctx.beginPath();ctx.ellipse(116 + 57 * progress, 0, 20 + 12 * progress, 46 + 27 * progress, 0, -.95, .95);ctx.stroke();
  ctx.strokeStyle = "#ffdc88";ctx.lineWidth = 1.5;ctx.beginPath();ctx.ellipse(123 + 57 * progress, 0, 19 + 12 * progress, 39 + 26 * progress, 0, -.85, .85);ctx.stroke();
  star(ctx, 52, 0, 31, "#d9a23c", .12);star(ctx, 52, 0, 25, "#83e7ff", .12);star(ctx, 52, 0, 16, "#edffff", .12);
  ctx.globalAlpha = 1;glow(ctx, 0, 0, 34, strength * .9);star(ctx, 0, 0, 25 * strength, `rgba(231,255,255,${alpha(strength)})`, .2);
  ctx.restore();
  if (age >= 0) {
    const flight = clamp(age / .43), brightness = clamp(1 - age / .55) * options.intensity;
    const x = 43 + flight * 160, y = 128 - Math.sin(flight * Math.PI) * 12;
    ctx.save();glow(ctx, x, y, 34, brightness * .8);
    const tailLength = Math.min(60, x - 4), tail = ctx.createLinearGradient(x - tailLength, y, x, y);tail.addColorStop(0, "rgba(32,135,255,0)");tail.addColorStop(1, `rgba(100,225,255,${alpha(brightness * .9)})`);
    ctx.fillStyle = tail;ctx.beginPath();ctx.moveTo(x - tailLength, y + 5);ctx.lineTo(x - 5, y - 11);ctx.lineTo(x + 6, y);ctx.lineTo(x - 5, y + 11);ctx.fill();
    star(ctx, x, y, 17, `rgba(255,219,133,${alpha(brightness)})`, flight * .5);star(ctx, x, y, 10, `rgba(236,255,255,${alpha(brightness)})`);
    for (let i = 0; i < 17; i++) {
      const a = (i / 16 - .5) * 1.65, p = clamp(progress * (1 + i % 4 * .1)), length = 65 + (i % 5) * 29;
      const sx = 40 + Math.cos(a) * length * p, sy = 128 + Math.sin(a) * length * .72 * p + 15 * p * p;
      const visibility = options.intensity * Math.pow(1 - p, 1.4) * Math.min(1, age * 14 + .15);
      star(ctx, sx, sy, i % 3 ? 2.3 : 4.4, i % 3 ? `rgba(65,160,255,${alpha(visibility)})` : `rgba(237,184,78,${alpha(visibility)})`, age * 2 + i);
    }
    ctx.restore();
  }
}

export async function createRigMagicEffectFrames(options, env) {
  const frames = magicEffectFrames(options), result = [];
  for (const frame of frames) {
    const canvas = env.createCanvas(256, 256);
    try {
      const ctx = canvas.getContext("2d");
      // Every frame retains the same transparent source grid and emitter origin.
      ctx.beginPath();ctx.rect(3, 3, 250, 250);ctx.clip();
      (frame.kind === "charge" ? charge : release)(ctx, frame.time, options);
      result.push({ ...frame, image: bytesToImageDataURL(await env.encode(canvas)) });
    } finally { canvas.width = 1;canvas.height = 1; }
  }
  return result;
}
