export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/authorization|api[-_]key/i.test(key)) {
      redacted[key] = redactValue(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export function redactValue(value: string): string {
  if (value.length <= 8) {
    return '***';
  }
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

export function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}
