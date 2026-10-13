export function backupWindow(at = new Date()) {
  const hour = Math.floor(at.getUTCHours() / 12) * 12;
  return `${at.toISOString().slice(0, 10)}T${hour.toString().padStart(2, "0")}`;
}
