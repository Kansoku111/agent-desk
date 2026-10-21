import table from './deepseek-pricing.json' with { type: 'json' }

/** USD per million tokens; metadata is part of the usage-cache signature. */
export function deepSeekPricing() {
  return Object.entries(table.models).map(([id, family]) => [`deepseek-official/${id}`, {
    ...table.rates[family], schedule: 'deepseek', holidays: table.holidays,
    source: table.source, checkedAt: table.checkedAt,
  }])
}

/** Use the response's logged time, independent of the computer's time zone. */
export function deepSeekRatesAt(rates, time) {
  // Missing timestamps cannot establish a discount; use the upper rate.
  if (!Number.isFinite(time)) return rates.peak
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) return rates.peak
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return rates.offPeak
  // Public holidays are Chinese calendar dates; UTC peak windows fall within
  // that same date in China. Unpublished years keep the weekday upper estimate.
  const chinaDay = new Date(time + 8 * 3_600_000).toISOString().slice(0, 10)
  const holiday = rates.holidays[chinaDay.slice(0, 4)]?.some(([from, to]) => chinaDay.slice(5) >= from && chinaDay.slice(5) <= to)
  if (holiday) return rates.offPeak
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10) ? rates.peak : rates.offPeak
}
