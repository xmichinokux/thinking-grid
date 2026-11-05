import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
export const HAIKU = 'claude-haiku-4-5-20251001';
export const JUDGE_MODEL = 'claude-opus-4-7';
// 費用の表示用。Opus は高いほうの見積もり
export const PRICE = { [HAIKU]: [1, 5], [JUDGE_MODEL]: [15, 75] };

export async function ask({ model, max_tokens, system, user }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY を設定してください');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        text: data.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        usage: data.usage,
        stop_reason: data.stop_reason,
      };
    }
    const body = (await res.text()).slice(0, 200);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 5000 * attempt));
      continue;
    }
    throw new Error(`${model} ${res.status} ${body}`);
  }
}

export const costOf = (model, usage) =>
  (usage.input_tokens * PRICE[model][0] + usage.output_tokens * PRICE[model][1]) / 1e6;

export async function pool(tasks, limit) {
  const out = new Array(tasks.length);
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      try { out[idx] = await tasks[idx](); } catch (e) { out[idx] = { error: String(e) }; }
      if (++done % 10 === 0) console.log(`  ${done}/${tasks.length}`);
    }
  }));
  return out;
}

export const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** 組ごとの差の平均と、組を引き直して出す 95% の幅（乱数は固定） */
export function pairedDiff(pairs) {
  const d = pairs.map(([a, b]) => b - a);
  let seed = 20261105;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const means = [];
  for (let i = 0; i < 10000; i++) {
    let s = 0;
    for (let j = 0; j < d.length; j++) s += d[Math.floor(rnd() * d.length)];
    means.push(s / d.length);
  }
  means.sort((a, b) => a - b);
  return {
    n: d.length, mean: avg(d), lo: means[249], hi: means[9749],
    up: d.filter((x) => x > 0).length, down: d.filter((x) => x < 0).length, tie: d.filter((x) => x === 0).length,
  };
}
