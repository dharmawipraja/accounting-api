/**
 * A tiny XML writer for the Coretax import files: elements and text only (no
 * attributes beyond the fixed root ones, no mixed content). Every text value
 * goes through `escapeXmlText`, element names are checked, so no caller value
 * can inject markup. Output layout (tab indentation, `<Empty/>` for an empty
 * value) matches DJP's published sample files.
 */

/** An element: a name and either its text or its child elements. */
export type XmlNode = [name: string, content: string | XmlNode[]];

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** Characters XML 1.0 cannot carry at all (C0 controls except tab / LF /
 *  CR, lone surrogates, U+FFFE / U+FFFF): dropped. */
const INVALID_XML_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape a text value for element content (also safe in attributes). */
export function escapeXmlText(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderNode([name, content]: XmlNode, depth: number): string {
  if (!NAME.test(name)) throw new Error(`Invalid XML element name: ${name}`);
  const pad = '\t'.repeat(depth);
  if (typeof content === 'string')
    return content === ''
      ? `${pad}<${name}/>`
      : `${pad}<${name}>${escapeXmlText(content)}</${name}>`;
  const children = content.map((c) => renderNode(c, depth + 1)).join('\n');
  return `${pad}<${name}>\n${children}\n${pad}</${name}>`;
}

/** A whole document: declaration + root (with its fixed attribute string,
 *  written verbatim — never caller input) + children. */
export function renderXmlDocument(
  root: string,
  rootAttributes: string,
  children: XmlNode[],
): string {
  if (!NAME.test(root)) throw new Error(`Invalid XML element name: ${root}`);
  const body = children.map((c) => renderNode(c, 1)).join('\n');
  return `<?xml version="1.0" encoding="utf-8" ?>\n<${root} ${rootAttributes}>\n${body}\n</${root}>`;
}
