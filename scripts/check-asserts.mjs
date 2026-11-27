// An assert that compares an expression with itself passes whatever the code does. After a refactor
// (a value renamed into another) such asserts appear silently; this fails the check run on them.
// Catches `assert.x(a, a, …)` and, in `deepEqual([…], […])`, the same expression at one position on
// both sides or twice in the actual list. Literals are skipped. Run: `npm run check`.
import { readFileSync, readdirSync } from 'node:fs';

// Top-level items of a comma list: commas inside calls, arrays and objects don't split.
function items(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  return [...out, cur.trim()];
}

const isExpr = (e) => /[A-Za-z_]/.test(e) && !/^(true|false|null|undefined)$/.test(e) && !/^['"`]/.test(e);

function findings(line) {
  const same = line.match(/assert\.\w+\(\s*([^,]+?)\s*,\s*\1\s*[,)]/);
  if (same && isExpr(same[1])) return [`same on both sides: ${same[1]}`];
  const deep = line.match(/assert\.deepEqual\(\s*\[(.*?)\]\s*,\s*\[(.*?)\]\s*[,)]/);
  if (!deep) return [];
  const actual = items(deep[1]), expected = items(deep[2]), seen = new Set(), out = [];
  actual.forEach((e, i) => {
    if (!isExpr(e)) return;
    if (e === expected[i]) out.push(`[${i}] on both sides: ${e}`);
    if (seen.has(e)) out.push(`twice in the actual list: ${e}`);
    seen.add(e);
  });
  return out;
}

// The detector checks itself first: each of these was a real tautology in check-link once.
for (const bad of [
  "assert.equal(dmmState().dstats.n, dmmState().dstats.n, 'x');",
  "assert.deepEqual([dmmState().dstats.n, dmmState().dstats.n, true], [n, n, true], 'x');",
  "assert.deepEqual([dmmState().logging, dmmState().dstats.n], [true, dmmState().dstats.n]);",
]) if (!findings(bad).length) throw new Error(`check-asserts misses: ${bad}`);
if (findings("assert.deepEqual([f('a', 1).u, f('b', 1).u], ['x', 'y'], 'z');").length) throw new Error('check-asserts: false hit');

const dir = new URL('.', import.meta.url);
const hits = readdirSync(dir).filter((f) => /^check-.*\.mts$/.test(f)).flatMap((f) =>
  readFileSync(new URL(f, dir), 'utf8').split('\n').flatMap((line, i) => findings(line).map((m) => `scripts/${f}:${i + 1}: ${m}`)));
if (hits.length) {
  console.error(`check-asserts: asserts that can't fail\n${hits.join('\n')}`);
  process.exit(1);
}
console.log('check-asserts: no self-comparing asserts');
