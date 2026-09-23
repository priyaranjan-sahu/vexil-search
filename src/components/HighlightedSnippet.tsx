/** Renders an FTS snippet safely: only <b>...</b> becomes bold, everything
 * else is escaped by React (no dangerouslySetInnerHTML). */
export function HighlightedSnippet({ text }: { text: string }) {
  const parts = text.split(/(<b>|<\/b>)/);
  let bold = false;
  const nodes: React.ReactNode[] = [];
  for (const part of parts) {
    if (part === "<b>") {
      bold = true;
    } else if (part === "</b>") {
      bold = false;
    } else if (part) {
      nodes.push(
        bold ? (
          <b key={nodes.length}>{part}</b>
        ) : (
          <span key={nodes.length}>{part}</span>
        ),
      );
    }
  }
  return <>{nodes}</>;
}
