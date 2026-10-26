/** 按引号规则拆分命令模板：路径含空格时用引号包裹。 */
export function splitCommand(template: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (const char of template) {
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}
