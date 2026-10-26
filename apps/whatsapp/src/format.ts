/**
 * Converte o Markdown comum para a formatação do WhatsApp.
 * Blocos de código (```) ficam como estão.
 */
export function toWhatsAppText(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => (index % 2 === 1 ? part : convertInline(part)))
    .join("")
    .trim();
}

function convertInline(text: string): string {
  return (
    text
      // Listas com * ou + viram "- " (antes do negrito, para não confundir).
      .replace(/^(\s*)[*+]\s+/gm, "$1- ")
      // Títulos viram negrito.
      .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, "*$1*")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      .replace(/~~(.+?)~~/g, "~$1~")
      // [texto](link) vira "texto (link)".
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
  );
}

/** Divide mensagens longas em partes, preferindo quebrar entre parágrafos e linhas. */
export function splitMessage(text: string, maxLength = 4000): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength);
    const cut = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const at = cut > maxLength / 2 ? cut : maxLength;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
