// Business runs on IST only. Device-local date (device TZ, not IST) can land
// on the wrong day near midnight for a customer/rider whose phone isn't set
// to IST — force the IST calendar date explicitly instead.
export function todayDateStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
