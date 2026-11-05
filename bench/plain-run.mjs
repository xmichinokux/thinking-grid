/**
 * 普通の短い頼みに足すと効くかを測る（2026-11-05）。
 * Claude と Gemini の両方で、新しい身近なお題で。
 *   none   = 何も足さない
 *   detail = 「詳しく書いて」（長さの比較用）
 *   five   = 【考え方】の 5 行
 *   last   = 最後の 1 行だけ（「浅い切り口は削る」が正体かを見る）
 *
 * node plain-run.mjs gen    作る（plain-raw.json）
 * node plain-run.mjs judge  採点（plain-judge.json）Opus 1 回・Gemini は順を変えて 2 回
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA, HAIKU, JUDGE_MODEL, ask, costOf, pool, avg, pairedDiff } from './common.mjs';

const GKEY = process.env.GEMINI_API_KEY;
const GEMINI = 'gemini-2.5-flash';

const FIVE = `【考え方】
- 根底の原理・メカニズムを優先する
- 個別の問いに答えつつ、一般原理から引く
- 表層の事実でなく、根底のメカニズムまで見る
- 別分野との軽い掛け合わせにとどめ、SF 的な飛躍はしない

浅い・個別すぎる・表層の切り口は削る。`;
const ARMS = [
  { id: 'none', name: '何も足さない', prefix: '' },
  { id: 'detail', name: '詳しく書いて', prefix: 'それぞれ詳しく書いてください。' },
  { id: 'five', name: '5 行', prefix: FIVE },
  { id: 'last', name: '最後の 1 行', prefix: '浅い・個別すぎる・表層の切り口は削る。' },
];
const TOPICS = [
  '町内会に入る人を増やしたい',
  '小さなカフェの平日の昼のお客さんを増やしたい',
  'PTA の役員の負担を減らしたい',
  '中小企業で若手がすぐ辞めるのを減らしたい',
  '個人ブログの読者を増やしたい',
];
const LABELS = ['甲', '乙', '丙', '丁'];
const RAW = path.join(DATA, 'plain-raw.json');
const JUDGED = path.join(DATA, 'plain-judge.json');

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
  for (const g of ['claude', 'gemini']) for (const topic of TOPICS) for (const arm of ARMS) for (let run = 1; run <= 3; run++) jobs.push({ g, topic, arm, run });
  let cost = 0;
  const made = await pool(jobs.map((j) => async () => {
    const user = `${j.arm.prefix ? j.arm.prefix + '\n\n' : ''}「${j.topic}」について、アイデアを 5 つ出してください。`;
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
  for (const g of ['claude', 'gemini']) for (const a of ARMS) {
    const xs = made.filter((m) => m.g === g && m.arm === a.id);
    console.log(g.padEnd(7), a.name.padEnd(8), '件', xs.length, '平均字数', Math.round(avg(xs.map((m) => m.text.length))), '切れた', xs.filter((m) => !['end_turn', 'STOP'].includes(m.stop)).length);
  }
  console.log('Haiku の費用', cost.toFixed(3), '| Gemini トークン', gIn, gOut);
}

const JUDGE = `あなたは、このお題を任された担当者です。
次の話し合いに持っていく案の束を選びます。同じお題から作られた 4 束を読んでください。

各束について答えます。
- take: 次の話し合いに持っていきたいか。5=ぜひ持っていきたい、1=持っていきたくない
- easy: 案の中身が安易でないか。5=よく考えられている、1=ありきたりで安易

文章の長さでは選ばないでください。

JSON のみで返す:
{"甲":{"take":n,"easy":n},"乙":{"take":n,"easy":n},"丙":{"take":n,"easy":n},"丁":{"take":n,"easy":n},"best":"甲|乙|丙|丁"}`;

async function judge() {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const sets = [];
  let t = 0;
  for (const g of ['claude', 'gemini']) for (const topic of TOPICS) for (let run = 1; run <= 3; run++) {
    const b = ARMS.map((a) => raw.find((r) => r.g === g && r.topic === topic && r.run === run && r.arm === a.id));
    if (b.some((x) => !x)) { console.log('欠け', g, topic, run); continue; }
    sets.push({ g, topic, run, b, k: t++ % 4 });
  }
  const jobs = [];
  for (const s of sets) {
    jobs.push({ s, who: 'opus', k: s.k });
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
        if (!LABELS.every((l) => typeof sc[l]?.take === 'number' && typeof sc[l]?.easy === 'number')) throw new Error('形が違う');
        return { g: j.s.g, topic: j.s.topic, run: j.s.run, who: j.who, k: j.k, scores: sc, map: Object.fromEntries(LABELS.map((l, i) => [l, items[i].arm])), chars: Object.fromEntries(items.map((it) => [it.arm, it.text.length])) };
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
    // Gemini の 2 回は、同じ組の平均にする
    const key = (o) => `${o.topic}|${o.run}`;
    const groups = [...new Set(rows.map(key))].map((id) => rows.filter((o) => key(o) === id));
    const val = (grp, arm, axis) => avg(grp.map((o) => o.scores[Object.keys(o.map).find((l) => o.map[l] === arm)][axis]));
    console.log(`\n【採点 ${who} / 作った AI ${g}】 組 ${groups.length} 採点 ${rows.length}`);
    for (const a of ARMS) {
      const wins = rows.filter((o) => o.map[o.scores.best] === a.id).length;
      console.log(a.name.padEnd(8), '持っていきたい', avg(groups.map((x) => val(x, a.id, 'take'))).toFixed(2), '安易でない', avg(groups.map((x) => val(x, a.id, 'easy'))).toFixed(2), `1位 ${wins}/${rows.length}`, '字数', Math.round(avg(groups.map((x) => x[0].chars[a.id]))));
    }
    for (const [x, y] of [['none', 'five'], ['none', 'last'], ['none', 'detail'], ['detail', 'five'], ['last', 'five']]) for (const axis of ['take', 'easy']) {
      const d = pairedDiff(groups.map((grp) => [val(grp, x, axis), val(grp, y, axis)]));
      console.log(`${x} → ${y} ${axis} ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(2)} 幅 ${d.lo.toFixed(2)}〜${d.hi.toFixed(2)} 上${d.up} 下${d.down} 同${d.tie}`);
    }
    // 長さの確認: 5 行が「詳しく」より短かった組だけで、5 行は勝っているか
    const shorter = groups.filter((grp) => grp[0].chars.five < grp[0].chars.detail);
    if (shorter.length) {
      const d = pairedDiff(shorter.map((grp) => [val(grp, 'detail', 'easy'), val(grp, 'five', 'easy')]));
      console.log(`5 行が詳しくより短い組 ${shorter.length}: 安易でない ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(2)} 上${d.up} 下${d.down} 同${d.tie}`);
    } else console.log('5 行が詳しくより短い組: なし');
    // 組の中で、長いほど点が高いか
    const xs = [], ys = [];
    for (const grp of groups) {
      const cs = ARMS.map((a) => grp[0].chars[a.id]), ss = ARMS.map((a) => val(grp, a.id, 'easy'));
      const mc = avg(cs), ms = avg(ss);
      cs.forEach((c, i) => { xs.push((c - mc) / mc); ys.push(ss[i] - ms); });
    }
    const mx = avg(xs), my = avg(ys);
    const r = xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) / Math.sqrt(xs.reduce((s, v) => s + (v - mx) ** 2, 0) * ys.reduce((s, v) => s + (v - my) ** 2, 0));
    console.log('組の中の長さと「安易でない」の相関', r.toFixed(2));
  }
  const pos = [0, 1, 2, 3].map((i) => avg(all.filter((o) => o.who === 'gemini').map((o) => o.scores[LABELS[i]].take)));
  const posO = [0, 1, 2, 3].map((i) => avg(all.filter((o) => o.who === 'opus').map((o) => o.scores[LABELS[i]].take)));
  console.log('\n提示の順ごとの平均 Gemini', pos.map((x) => x.toFixed(2)).join(' '), '| Opus', posO.map((x) => x.toFixed(2)).join(' '));
}

const stage = process.argv[2];
if (stage === 'gen') await gen();
else if (stage === 'judge') await judge();
else if (stage === 'report') report();
else console.log('gen / judge / report');
