export async function measureServerSpan<T>(
  name: string,
  operation: () => Promise<T>,
  details: Record<string, string | number | boolean | null> = {}
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    console.log(JSON.stringify({
      event: 'gateway_span',
      span: name,
      durationMs,
      ...details
    }));
  }
}
