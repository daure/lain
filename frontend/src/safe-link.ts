export function safeLink(value?: string): { url: string; hostname: string } | undefined {
  if (!value || value.length > 4096 || !/^https?:\/\/[^/]/i.test(value) || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password) return;
    return { url: url.href, hostname: url.hostname };
  } catch { return; }
}
