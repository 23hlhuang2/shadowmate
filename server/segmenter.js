/**
 * 自动分句。实现 PRD 表 6 的规则：
 *  - 停顿 ≥ 0.35s 切句
 *  - 单句最短 0.8s，过短合并到相邻句
 *  - 单句最长 15s，超长在次优停顿点强制切分
 *  - 句末标点作为切分的强信号
 */

export const DEFAULT_RULES = {
  pauseThreshold: 0.35,
  minUnitSeconds: 0.8,
  maxUnitSeconds: 15
};

const END_PUNCT = /[.?!。？！]["'”’)\]]*$/;
const NO_LEADING_SPACE = /^[.,!?;:'’)\]}%]/;

const round3 = (n) => Math.round(n * 1000) / 1000;

function joinWords(group) {
  let out = '';
  for (const item of group) {
    if (!out) out = item.word;
    else if (NO_LEADING_SPACE.test(item.word)) out += item.word;
    else out += ' ' + item.word;
  }
  return out;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function groupWords(words, pauseThreshold) {
  const groups = [];
  let current = null;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const prev = words[i - 1];
    const gap = prev ? Math.max(0, word.start - prev.end) : 0;
    const isBoundary = !current || gap >= pauseThreshold || (prev && END_PUNCT.test(prev.word));
    if (isBoundary) {
      current = [word];
      groups.push(current);
    } else {
      current.push(word);
    }
  }
  return groups;
}

function spanOf(group) {
  return group[group.length - 1].end - group[0].start;
}

function mergeShortGroups(groups, minUnitSeconds) {
  const merged = [];
  for (const group of groups) {
    if (merged.length && spanOf(group) < minUnitSeconds) {
      merged[merged.length - 1] = merged[merged.length - 1].concat(group);
    } else {
      merged.push(group);
    }
  }
  if (merged.length > 1 && spanOf(merged[0]) < minUnitSeconds) {
    merged[1] = merged[0].concat(merged[1]);
    merged.shift();
  }
  return merged;
}

function splitLongGroups(groups, maxUnitSeconds) {
  const out = [];
  for (const group of groups) {
    let rest = group;
    while (spanOf(rest) > maxUnitSeconds && rest.length > 1) {
      let bestIndex = -1;
      let bestScore = -Infinity;
      for (let i = 1; i < rest.length; i += 1) {
        const gap = rest[i].start - rest[i - 1].end;
        const balance = 1 - Math.abs(i / rest.length - 0.5) * 2;
        const score = gap + balance * 0.3;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
      if (bestIndex <= 0) break;
      out.push(rest.slice(0, bestIndex));
      rest = rest.slice(bestIndex);
    }
    out.push(rest);
  }
  return out;
}

export function segmentWords(words, rules = {}) {
  const { pauseThreshold, minUnitSeconds, maxUnitSeconds } = { ...DEFAULT_RULES, ...rules };
  if (!Array.isArray(words) || words.length === 0) return [];

  const groups = splitLongGroups(
    mergeShortGroups(groupWords(words, pauseThreshold), minUnitSeconds),
    maxUnitSeconds
  );

  return groups.map((group, index) => {
    const start = group[0].start;
    const end = group[group.length - 1].end;
    return {
      index,
      text: joinWords(group),
      start: round3(start),
      end: round3(end),
      duration: round3(end - start),
      wordCount: group.length,
      confidence: round3(average(group.map((w) => w.confidence ?? 0.9))),
      words: group.map((w) => ({
        word: w.word,
        start: round3(w.start),
        end: round3(w.end),
        confidence: round3(w.confidence ?? 0.9)
      }))
    };
  });
}

export function flattenPhrases(phrases) {
  const words = [];
  for (const phrase of phrases || []) {
    for (const word of phrase.words || []) {
      const text = (word.text ?? word.word ?? '').trim();
      if (!text) continue;
      words.push({
        word: text,
        start: word.start ?? word.offsetSeconds ?? 0,
        end: word.end ?? ((word.offsetSeconds ?? 0) + (word.durationSeconds ?? 0)),
        confidence: word.confidence ?? 0.9
      });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}