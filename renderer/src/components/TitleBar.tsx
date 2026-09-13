// Optional custom title bar. The app currently uses the OS window frame,
// so this component is not wired into the layout; kept as a ready-to-use
// shell for when frameless mode is adopted.
export function TitleBar() {
  return (
    <div className="flex h-10 items-center justify-between border-b border-line bg-card px-4 select-none">
      <span className="text-xs font-semibold tracking-wide text-ink2">
        EnTransfer
      </span>
    </div>
  )
}
