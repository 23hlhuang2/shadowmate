/**
 * 反馈生成。实现 PRD §7.5 表 9 的分段结论与"最弱维度优先"的建议策略。
 */

const DIMENSION_META = [
  { key: 'accuracy', label: '准确度' },
  { key: 'fluency', label: '流利度' },
  { key: 'prosody', label: '语调' },
  { key: 'completeness', label: '完整性' }
];

const ADVICE = {
  accuracy: [
    '元音开口度不够，先单独把难词慢读三遍，再放回整句。',
    '辅音连缀读得含糊，把连缀拆开慢读一遍再连起来。',
    '重音位置偏移，注意多音节词的重音落在哪一拍。'
  ],
  fluency: [
    '句中停顿偏多，先用 0.75× 完整跟读一遍，再回到原速。',
    '语速忽快忽慢，跟着原声的节奏打拍子，保持稳定。',
    '连读不足，把相邻的辅音与元音连起来读，减少逐词顿开。'
  ],
  prosody: [
    '语调偏平，陈述句句末应自然降调，不要每句都上扬。',
    '实词重音不明显，把句中的关键词读得更重一些。',
    '节奏感不足，注意重读音节与非重读音节的强弱对比。'
  ],
  completeness: [
    '有单词被吞掉，注意把每个词完整读出，尤其是句末辅音。',
    '句末音量过小，容易被判为缺失，收尾时保持音量。',
    '漏读了冠词或介词，注意不要省略虚词。'
  ]
};

export function verdictFor(overall) {
  if (overall >= 85) {
    return { band: 'good', text: '发音到位，语流自然，可以进入下一句。' };
  }
  if (overall >= 70) {
    return { band: 'warn', text: '整体不错，语调还有提升空间。' };
  }
  return { band: 'bad', text: '建议先放慢速度，再跟读一遍。' };
}

export function scoreBand(score) {
  if (score >= 85) return 'good';
  if (score >= 70) return 'warn';
  return 'bad';
}

export function buildSuggestions(scores, words = []) {
  const ranked = DIMENSION_META
    .map((d) => ({ ...d, value: scores[d.key] ?? 0 }))
    .sort((a, b) => a.value - b.value);

  const suggestions = [];
  const worstWords = words
    .filter((w) => w.score < 78 && w.errorType !== 'Omission')
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);

  if (worstWords.length) {
    const list = worstWords.map((w) => w.word.replace(/[.,!?;:]$/, '')).join('、');
    suggestions.push({
      dimension: ranked[0].label,
      text: `这几个词是主要扣分点：${list}。单独慢读三遍，再放回整句连读。`
    });
  }

  suggestions.push({
    dimension: ranked[0].label,
    text: ADVICE[ranked[0].key][0]
  });

  if (ranked[1].value < 85) {
    suggestions.push({
      dimension: ranked[1].label,
      text: ADVICE[ranked[1].key][0]
    });
  }

  if (scores.overall >= 85) {
    suggestions.push({
      dimension: '节奏',
      text: '本句整体表现优秀，保持这个节奏进入下一句即可。'
    });
  } else {
    suggestions.push({
      dimension: '练习方法',
      text: '先降到 0.75× 跟读两遍，再回到 1.0× 复练一次，通常能明显改善。'
    });
  }

  return suggestions.slice(0, 4);
}

export function buildFeedback(assessment) {
  const overall = assessment.overall;
  const words = assessment.words || [];
  const scores = {
    overall,
    accuracy: assessment.accuracy,
    fluency: assessment.fluency,
    prosody: assessment.prosody,
    completeness: assessment.completeness
  };

  return {
    ...assessment,
    verdict: verdictFor(overall),
    dimensions: DIMENSION_META.map((d) => ({
      key: d.key,
      label: d.label,
      value: scores[d.key],
      band: scoreBand(scores[d.key])
    })),
    suggestions: buildSuggestions(scores, words),
    words: words.map((w) => ({
      ...w,
      band: w.errorType === 'Omission' ? 'bad' : scoreBand(w.score)
    }))
  };
}