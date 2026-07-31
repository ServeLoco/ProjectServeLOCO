// Local YYYY-MM-DD (not toISOString, which shifts to UTC and can land on the
// wrong day near midnight for IST users).
export function todayDateStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
