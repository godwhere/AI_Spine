import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";

export function PreviewTransport({ clock, duration = 1, animation, animations = [], onAnimation, onTogglePlay, playing, label = "模板" }) {
  const [position, setPosition] = useState(0);
  const length = Math.max(0.01, duration || 1);
  useEffect(() => {
    const update = () => setPosition(((clock.read() % length) + length) % length);
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [clock, length, animation]);
  const seek = (value) => {
    if (clock.seek) clock.seek(value);
    else { clock.position = value; clock.anchor = performance.now(); }
    setPosition(value);
  };
  return <div className="preview-transport">
    <button className="transport-play" aria-label={label === "模板" ? playing ? "暂停预览" : "播放预览" : playing ? "暂停资源预览" : "播放资源预览"} disabled={!animations.length} onClick={onTogglePlay}>{playing ? <Pause size={20} /> : <Play size={20} />}</button>
    <select aria-label={label === "模板" ? "选择预览动作" : "资源预览动作"} value={animation} disabled={!animations.length} onChange={(event) => onAnimation(event.target.value)}>{animations.map((name) => <option key={name}>{name}</option>)}</select>
    <label className="transport-progress"><input type="range" aria-label={`${label}预览进度`} min="0" max={length} step="0.01" value={Math.min(position, length)} onChange={(event) => seek(Number(event.target.value))} disabled={!animations.length} /><span>{position.toFixed(1)} s <i>/</i> {length.toFixed(1)} s</span></label>
  </div>;
}
