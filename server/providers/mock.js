import crypto from 'node:crypto';

/**
 * 本地模拟提供方：无需任何凭据即可跑通完整链路。
 *
 * 识别结果由音频元信息派生，评测结果由「录音字节 + 参考文本」派生，
 * 因此同一段录音重复提交得到相同分数，不同录音会得到不同分数 —— 行为可预测、
 * 便于前端联调与演示，但不代表真实发音水平。
 */

const CORPUS = [
  'Hey there, welcome back to the show.',
  "Today we're talking about how habits shape our lives.",
  'It turns out that small changes really do add up.',
  "So let's start with the science behind it.",
  'Your brain builds routines to save energy.',
  "That's why the first step always feels the hardest.",
  "But once it's automatic, it runs on its own.",
  'Try it for a week and see what happens.',
  "Alright, that's all for today's episode.",
  'Thanks for listening, and see you next time.',
  "Don't forget to subscribe if you enjoyed it.",
  'Until then, take care and keep practicing.',
  'Most people overestimate what they can do in a day.',
  'And they underestimate what they can do in a year.',
  'The trick is to make the habit smaller than you think.',
  'Two minutes is enough to get started.',
  'Consistency beats intensity almost every single time.',
  "Let me give you a quick example from my own life.",
  'I used to read for hours and then stop for weeks.',
  'Now I read ten pages every morning before coffee.',
  'It sounds trivial, but the streak is what matters.',
  'Your environment matters more than your willpower.',
  'Put the guitar in the middle of the room.',
  'Hide the snacks where you cannot see them.',
  'Design your space so the good choice is the easy one.',
  'That is the whole idea behind this episode.',
  'Give it a shot and tell me how it goes.',
  'See you in the next one, and keep going.'
];

function fnv1a(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

export async function transcribe({ audio }) {
  const seed = fnv1a(`${audio.id}|${audio.name}|${audio.size}|${audio.durationSec}`);
  const rand = mulberry32(seed);
  const duration = audio.durationSec;

  const wordsPerSecond = 2.55;
  const targetWords = Math.max(6, Math.round(duration * wordsPerSecond));

  const sentences = [];
  let totalWords = 0;
  let cursor = seed % CORPUS.length;
  while (totalWords < targetWords && sentences.length < 90) {
    const sentence = CORPUS[cursor % CORPUS.length];
    sentences.push(sentence);
    totalWords += sentence.split(/\s+/).length;
    cursor += 1;
  }

  const sentencePause = 0.45;
  const leadIn = 0.35;
  const usable = Math.max(1, duration - leadIn - 0.3 - sentencePause * sentences.length);
  const perWord = usable / totalWords;

  const words = [];
  let t = leadIn;
  for (const sentence of sentences) {
    for (const token of sentence.split(/\s+/)) {
      words.push({
        word: token,
        start: round3(t),
        end: round3(t + perWord * 0.86),
        confidence: round3(0.9 + rand() * 0.09)
      });
      t += perWord;
    }
    t += sentencePause;
  }

  return {
    provider: 'mock',
    language: 'en-US',
    durationSec: duration,
    confidence: 0.94,
    words
  };
}

export async function assess({ audioBuffer, referenceText, unitIndex }) {
  const digest = crypto.createHash('sha256').update(audioBuffer).digest('hex').slice(0, 16);
  const seed = fnv1a(`${referenceText}|${unitIndex}|${digest}`);
  const rand = mulberry32(seed);

  const accuracy = Math.round(64 + rand() * 32);
  const fluency = Math.round(62 + rand() * 34);
  const prosody = Math.round(58 + rand() * 38);
  const completeness = Math.round(74 + rand() * 25);
  const overall = Math.round(accuracy * 0.4 + fluency * 0.25 + prosody * 0.2 + completeness * 0.15);

  const tokens = referenceText.split(/\s+/).filter(Boolean);
  const words = tokens.map((token, index) => {
    const noise = (rand() - 0.5) * 36;
    let score = Math.round(Math.min(100, Math.max(30, accuracy + noise)));
    let errorType = 'None';

    if (completeness < 82 && index === tokens.length - 1 && tokens.length > 2) {
      score = Math.min(score, 58);
      errorType = 'Omission';
    } else if (score < 70) {
      errorType = 'Mispronunciation';
    }

    return { word: token, score, errorType };
  });

  return {
    provider: 'mock',
    referenceText,
    overall,
    accuracy,
    fluency,
    prosody,
    completeness,
    words,
    confidence: 0.9
  };
}