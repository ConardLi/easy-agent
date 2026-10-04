export function AppMark() {
  return (
    <div className="relative mb-5">
      <div className="absolute inset-0 rounded-[18px] bg-accent opacity-30 blur-xl" />
      <div className="relative flex size-12 items-center justify-center rounded-[15px] bg-[linear-gradient(145deg,var(--accent),color-mix(in_oklab,var(--accent)_55%,black))] shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_8px_20px_-8px_var(--accent)]">
        <svg viewBox="0 0 32 32" className="size-7" fill="none" aria-hidden>
          <path d="M9.5 22 16 8.5 22.5 22M12.3 17.2h7.4" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
