/** Server-sent events: the `data:` lines of each blank-line-separated frame, joined. */
export function* sseFrames(text: string): Generator<string> {
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) yield data;
  }
}
