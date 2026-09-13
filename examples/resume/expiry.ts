export function endSessionAt(expiresAt: Date, close: () => void) {
  const timer = setTimeout(close, Math.max(0, expiresAt.getTime() - Date.now()));
  timer.unref();
  return () => clearTimeout(timer);
}
