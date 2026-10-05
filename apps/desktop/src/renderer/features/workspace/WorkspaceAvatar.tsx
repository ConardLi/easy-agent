export function WorkspaceAvatar({ name, color, size = 22 }: { name: string; color: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[7px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]"
      style={{ width: size, height: size, fontSize: size * 0.5, background: `linear-gradient(140deg, ${color}, color-mix(in oklab, ${color} 70%, black))` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
