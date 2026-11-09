export const PRESETS: { label: string; expr: string }[] = [
  { label: 'Every 5 minutes', expr: '*/5 * * * *' },
  { label: 'Every 15 minutes', expr: '*/15 * * * *' },
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Every day at midnight', expr: '0 0 * * *' },
  { label: 'Every Monday at 09:00', expr: '0 9 * * 1' },
  { label: 'First of every month', expr: '0 0 1 * *' },
];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const field = /^(\*|(\d+)(-\d+)?)(\/\d+)?(,(\d+)(-\d+)?(\/\d+)?)*$/;
  return parts.every(part => field.test(part));
}

export function describeCron(expression: string): string {
  const preset = PRESETS.find(item => item.expr === expression.trim());
  if (preset) return preset.label;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/);
  if (![minute, hour, dayOfMonth, month, dayOfWeek].every(Boolean)) return expression;
  const at = (hours: string, minutes: string) => hours.padStart(2, '0') + ':' + minutes.padStart(2, '0') + ' UTC';
  const everyN = minute.match(/^\*\/(\d+)$/);
  if (everyN && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return 'Every ' + everyN[1] + ' minutes';
  if (minute === '0' && hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') return 'Every hour';
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    if (dayOfMonth === '*' && dayOfWeek === '*') return 'Every day at ' + at(hour, minute);
    if (dayOfMonth === '*' && /^\d$/.test(dayOfWeek)) return 'Every ' + DAYS[Number(dayOfWeek)] + ' at ' + at(hour, minute);
    if (/^\d+$/.test(dayOfMonth) && dayOfWeek === '*') return 'Day ' + dayOfMonth + ' of every month at ' + at(hour, minute);
  }
  return expression;
}
