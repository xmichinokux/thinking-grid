/**
 * 座標の数字だけを動かすと、案は変わるか（2026-11-06）。dial-run.mjs の言葉を数字に置き換えた形。
 * SET=N は軸の名前と数字だけ、SET=W は言葉を固定して数字だけ。
 * SET=N node num-dial-run.mjs gen / judge / report
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA, HAIKU, JUDGE_MODEL, ask, costOf, pool, avg, pairedDiff } from './common.mjs';

const GKEY = process.env.GEMINI_API_KEY;
const GEMINI = 'gemini-2.5-flash';

/* ★数字だけを動かす。組 N は軸の名前と数字だけ、組 W は言葉を固定して数字だけ動かす。高は 5、低は 1 */
const SET = process.env.SET === 'W' ? 'W' : 'N';
const NUM = { h: 5, l: 1 };
const prefix = (a, l) => SET === 'N' ? `【思考の座標（5 段階）】
- 抽象度: ${NUM[a]}/5
- 共通性: 3/5
- 深層度: 5/5
- 飛躍度: ${NUM[l]}/5

座標から外れる切り口は削る。` : `【思考の座標（5 段階）】
- 抽象度: ${NUM[a]}/5（根底の原理・メカニズムを優先）
- 共通性: 3/5（個別の問いに答えつつ、一般原理から引く）
- 深層度: 5/5（表層の事実でなく、根底のメカニズムまで見る）
- 飛躍度: ${NUM[l]}/5（別分野との軽い掛け合わせ。SF 的な飛躍はしない）

座標から外れる切り口（浅い/個別過ぎ/表層）は削る。`;
const ARMS = [
  { id: 'hl', a: 'h', l: 'l', name: '抽象5・飛躍1' },
  { id: 'll', a: 'l', l: 'l', name: '抽象1・飛躍1' },
  { id: 'hh', a: 'h', l: 'h', name: '抽象5・飛躍5' },
  { id: 'lh', a: 'l', l: 'h', name: '抽象1・飛躍5' },
];
const TOPICS = [
  '町内会に入る人を増やしたい',
  '小さなカフェの平日の昼のお客さんを増やしたい',
  'PTA の役員の負担を減らしたい',
  '中小企業で若手がすぐ辞めるのを減らしたい',
  '個人ブログの読者を増やしたい',
];
const RUNS = 2;
const LABELS = ['甲', '乙', '丙', '丁'];
const AXES = ['concrete', 'leap', 'take'];
const RAW = path.join(DATA, `num-${SET}-raw.json`);
const JUDGED = path.join(DATA, `num-${SET}-judge.json`);

let gIn = 0, gOut = 0;
async function gemini({ system, user, max, json }) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GKEY },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: max, ...(json ? { temperature: 0.3, responseMimeType: 'application/json' } : {}) },
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (res.ok) {
      const d = await res.json();
      gIn += d.usageMetadata?.promptTokenCount ?? 0;
      gOut += (d.usageMetadata?.candidatesTokenCount ?? 0) + (d.usageMetadata?.thoughtsTokenCount ?? 0);
      const c = d.candidates?.[0];
      return { text: c?.content?.parts?.map((p) => p.text || '').join('') ?? '', stop: c?.finishReason };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise((r) => setTimeout(r, 8000 * attempt)); continue; }
    throw new Error(`Gemini ${res.status}`);
  }
}

async function gen() {
  const jobs = [];
  for (const g of ['claude', 'gemini']) for (const topic of TOPICS) for (const arm of ARMS) for (let run = 1; run <= RUNS; run++) jobs.push({ g, topic, arm, run });
  let cost = 0;
  const made = await pool(jobs.map((j) => async () => {
    const user = `${prefix(j.arm.a, j.arm.l)}\n\n「${j.topic}」について、アイデアを 5 つ出してください。`;
    if (j.g === 'claude') {
      const r = await ask({ model: HAIKU, max_tokens: 6000, user });
      cost += costOf(HAIKU, r.usage);
      return { g: j.g, arm: j.arm.id, topic: j.topic, run: j.run, text: r.text, stop: r.stop_reason };
    }
    const r = await gemini({ user, max: 16000 });
    return { g: j.g, arm: j.arm.id, topic: j.topic, run: j.run, text: r.text, stop: r.stop };
  }), 4);
  const bad = made.filter((m) => m.error);
  if (bad.length) console.log('失敗', bad.length, String(bad[0].error).slice(0, 120));
  fs.writeFileSync(RAW, JSON.stringify(made.filter((m) => !m.error), null, 1), 'utf8');
  const c = (t, w) => (t.match(new RegExp(w, 'g')) || []).length;
  for (const g of ['claude', 'gemini']) for (const a of ARMS) {
    const xs = made.filter((m) => m.g === g && m.arm === a.id);
    console.log(g.padEnd(7), a.name, '件', xs.length, '字数', Math.round(avg(xs.map((m) => m.text.length))), '切れた', xs.filter((m) => !['end_turn', 'STOP'].includes(m.stop)).length, 'メカニズム等', avg(xs.map((m) => c(m.text, 'メカニズム|原理|根底|本質'))).toFixed(1));
  }
  console.log('Haiku の費用', cost.toFixed(3), '| Gemini トークン', gIn, gOut);
}

const JUDGE = `同じお題から作られた 4 束のアイデアを読みます。良し悪しだけでなく、案の性質を見てください。

各束について答えます。
- concrete: 来週すぐ動けるほど具体的か。5=手順まで具体的、1=抽象的な考え方にとどまる
- leap: 常識の外から発想しているか。5=大きく外れている、1=常識の範囲
- take: 次の話し合いに持っていきたいか。5=ぜひ持っていきたい、1=持っていきたくない

文章の長さでは判断しないでください。

JSON のみで返す:
{"甲":{"concrete":n,"leap":n,"take":n},"乙":{"concrete":n,"leap":n,"take":n},"丙":{"concrete":n,"leap":n,"take":n},"丁":{"concrete":n,"leap":n,"take":n}}`;

async function judge() {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const sets = [];
  let t = 0;
  for (const g of ['claude', 'gemini']) for (const topic of TOPICS) for (let run = 1; run <= RUNS; run++) {
    const b = ARMS.map((a) => raw.find((r) => r.g === g && r.topic === topic && r.run === run && r.arm === a.id));
    if (b.some((x) => !x)) { console.log('欠け', g, topic, run); continue; }
    sets.push({ g, topic, run, b, k: t++ % 4 });
  }
  const jobs = [];
  for (const s of sets) {
    if (s.g === 'claude') jobs.push({ s, who: 'opus', k: s.k });
    jobs.push({ s, who: 'gemini', k: s.k });
    jobs.push({ s, who: 'gemini', k: (s.k + 2) % 4 });
  }
  let cost = 0;
  const out = await pool(jobs.map((j) => async () => {
    const items = [...j.s.b.slice(j.k), ...j.s.b.slice(0, j.k)];
    const user = `【お題】${j.s.topic}\n\n` + items.map((it, i) => `━━━━━ ${LABELS[i]} ━━━━━\n${it.text}`).join('\n\n');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let text;
        if (j.who === 'opus') {
          const r = await ask({ model: JUDGE_MODEL, max_tokens: 1000, system: JUDGE, user });
          cost += costOf(JUDGE_MODEL, r.usage);
          text = r.text;
        } else text = (await gemini({ system: JUDGE, user, max: 12000, json: true })).text;
        const sc = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
        if (!LABELS.every((l) => AXES.every((x) => typeof sc[l]?.[x] === 'number'))) throw new Error('形が違う');
        return { g: j.s.g, topic: j.s.topic, run: j.s.run, who: j.who, k: j.k, scores: sc, map: Object.fromEntries(LABELS.map((l, i) => [l, items[i].arm])) };
      } catch (e) { if (attempt === 3) throw e; }
    }
  }), 4);
  const bad = out.filter((o) => o.error);
  if (bad.length) console.log('失敗', bad.length, String(bad[0].error).slice(0, 120));
  fs.writeFileSync(JUDGED, JSON.stringify(out.filter((o) => !o.error), null, 1), 'utf8');
  console.log('Opus の費用（高いほうの見積もり）', cost.toFixed(2), '| Gemini トークン', gIn, gOut);
  report();
}

function report() {
  const all = JSON.parse(fs.readFileSync(JUDGED, 'utf8'));
  for (const who of ['opus', 'gemini']) for (const g of ['claude', 'gemini']) {
    const rows = all.filter((o) => o.who === who && o.g === g);
    const key = (o) => `${o.topic}|${o.run}`;
    const groups = [...new Set(rows.map(key))].map((id) => rows.filter((o) => key(o) === id));
    const val = (grp, arm, axis) => avg(grp.map((o) => o.scores[Object.keys(o.map).find((l) => o.map[l] === arm)][axis]));
    if (!rows.length) continue;
    console.log(`\n【採点 ${who} / 作った AI ${g}】 組 ${groups.length} 採点 ${rows.length}`);
    for (const a of ARMS) console.log(a.name.padEnd(16), AXES.map((x) => `${x} ${avg(groups.map((grp) => val(grp, a.id, x))).toFixed(2)}`).join(' '));
    // つまみの主効果: 飛躍を固定して抽象だけ下げる／抽象を固定して飛躍だけ上げる
    const eff = (label, pairs, axis) => {
      const d = pairedDiff(groups.flatMap((grp) => pairs.map(([x, y]) => [val(grp, x, axis), val(grp, y, axis)])));
      console.log(`${label} ${axis} ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(2)} 幅 ${d.lo.toFixed(2)}〜${d.hi.toFixed(2)} 上${d.up} 下${d.down} 同${d.tie}`);
    };
    for (const axis of AXES) eff('抽象を下げる', [['hl', 'll'], ['hh', 'lh']], axis);
    for (const axis of AXES) eff('飛躍を上げる', [['hl', 'hh'], ['ll', 'lh']], axis);
  }
  const pos = (w) => [0, 1, 2, 3].map((i) => avg(all.filter((o) => o.who === w).map((o) => o.scores[LABELS[i]].take)).toFixed(2)).join(' ');
  console.log('\n提示の順ごとの take Gemini', pos('gemini'), '| Opus', pos('opus'));
}

const stage = process.argv[2];
if (stage === 'gen') await gen();
else if (stage === 'judge') await judge();
else if (stage === 'report') report();
else console.log('gen / judge / report');
