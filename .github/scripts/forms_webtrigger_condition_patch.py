from pathlib import Path

payload_path = Path('.github/scripts/prepare_it_webtrigger_payload.py')
payload = payload_path.read_text()
payload = payload.replace("'sourceId': f.get('sourceId',''),\n            'name': f.get('name',''),", "'sourceId': f.get('sourceId',''),\n            'sourceName': f.get('sourceName',''),\n            'name': f.get('name',''),")
payload = payload.replace("'sequence': int(f.get('sequence') or 0),\n        })", "'sequence': int(f.get('sequence') or 0),\n            'visibilityExpression': f.get('visibilityExpression',''),\n            'options': f.get('options',[]),\n        })")
payload_path.write_text(payload)

path = Path('src/productionMigrationWebtrigger.ts')
source = path.read_text()
source = source.replace("  sourceId?: string;\n  name: string;", "  sourceId?: string;\n  sourceName?: string;\n  name: string;")
source = source.replace("  sequence?: number;\n};", "  sequence?: number;\n  visibilityExpression?: string;\n  options?: string[];\n};", 1)

marker = "function normalise(value: unknown): string {\n  return String(value ?? '').trim().toLocaleLowerCase().replace(/\\s+/g, ' ');\n}\n"
helper = r'''

type ParsedVisibilityCheck = { sourceName: string; value: string };
function parseVisibilityExpression(expression: unknown): ParsedVisibilityCheck[] {
  const text = String(expression ?? '').replace(/\r?\n/g, ' ').trim();
  if (!text) return [];
  const checks: ParsedVisibilityCheck[] = [];
  const matcher = /([A-Za-z_][A-Za-z0-9_]*)\s*==\s*(?:"([^"]*)"|'([^']*)'|(true|false))/gi;
  for (const match of text.matchAll(matcher)) {
    const raw = String(match[2] ?? match[3] ?? match[4] ?? '').trim();
    checks.push({ sourceName: String(match[1]), value: /^(true|false)$/i.test(raw) ? raw.toLowerCase() : raw });
  }
  return checks;
}
'''
if marker not in source:
  raise SystemExit('normalise marker missing')
source = source.replace(marker, marker + helper, 1)

source = source.replace(
  "const mapped: Array<{ qid: string; sequence: number }> = [];",
  "const mapped: Array<{ qid: string; sequence: number; sourceName: string; name: string; jiraFieldId: string; jiraType: string; visibilityExpression: string }> = [];"
)
source = source.replace(
  "mapped.push({ qid, sequence: Number(field.sequence ?? 0) });",
  "mapped.push({ qid, sequence: Number(field.sequence ?? 0), sourceName: String(field.sourceName ?? ''), name: field.name, jiraFieldId: String(jiraField.id), jiraType: String(field.jiraType ?? 'text'), visibilityExpression: String(field.visibilityExpression ?? '').trim() });"
)

path.write_text(source)
