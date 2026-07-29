const MIN_ABSTRACT_LENGTH = 80;

const SIGNALS = {
  question: /旨在|目的|研究问题|探讨|评估|考察|是否|whether|investigat|aim|objective|examin|evaluat|assess/i,
  methods:
    /采用|使用|基于|数据|样本|模型|实验|调查|访谈|回归|随机|对照|参与者|method|conduct|data|sample|model|experiment|survey|interview|regression|randomi[sz]ed|participants|measur/i,
  findings:
    /结果|发现|表明|显示|显著|增加|下降|关联|results?|findings?|found|show(?:ed|s)?|significant|associated|increase|decrease|improv/i,
  limitations: /局限|限制|不足|仅|不能|尚未|未来|仍需|however|limitation|limited|only|cannot|future|short|exclude/i,
};

const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'among',
  'been',
  'being',
  'between',
  'could',
  'from',
  'have',
  'into',
  'more',
  'results',
  'showed',
  'study',
  'that',
  'their',
  'these',
  'this',
  'using',
  'were',
  'with',
  'would',
  '一个',
  '以及',
  '也不能',
  '其中',
  '之间',
  '可以',
  '可能',
  '关系',
  '数据',
  '方法',
  '是否',
  '显示',
  '更高',
  '未来',
  '本研究',
  '本文',
  '来自',
  '研究',
  '结果',
  '能够',
  '表明',
  '进行',
  '采用',
  '需要',
  '通过',
]);

export class LiteratureInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiteratureInputError';
    this.code = code;
  }
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?])|(?<=\.)\s+|;\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function selectSentences(sentences, signal, limit) {
  return sentences.filter((sentence) => signal.test(sentence)).slice(0, limit);
}

function countWords(text) {
  const segmenter = new Intl.Segmenter(['zh-CN', 'en'], { granularity: 'word' });
  return [...segmenter.segment(text)].filter((segment) => segment.isWordLike).length;
}

function keywordTokens(text) {
  const segmenter = new Intl.Segmenter(['zh-CN', 'en'], { granularity: 'word' });
  return [...segmenter.segment(text)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.toLocaleLowerCase())
    .filter((word) => {
      if (STOP_WORDS.has(word) || /^\d+(?:\.\d+)?$/u.test(word)) {
        return false;
      }
      if (/^[a-z]/u.test(word)) {
        return word.length >= 3;
      }
      return /[\p{Script=Han}]/u.test(word) && word.length >= 2;
    });
}

function titlePhraseTokens(title) {
  return (title.match(/[\p{Script=Han}]{2,24}/gu) ?? [])
    .flatMap((phrase) => phrase.split(/与|和|及|对|的/u))
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 2 && phrase.length <= 10 && !STOP_WORDS.has(phrase));
}

function extractKeywords(title, abstract) {
  const scores = new Map();

  for (const phrase of titlePhraseTokens(title)) {
    scores.set(phrase, (scores.get(phrase) ?? 0) + 6);
  }

  for (const [text, weight] of [
    [title, 3],
    [abstract, 1],
  ]) {
    for (const token of keywordTokens(text)) {
      scores.set(token, (scores.get(token) ?? 0) + weight);
    }
  }

  const ranked = [...scores.entries()].sort(([wordA, scoreA], [wordB, scoreB]) => {
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    return wordB.length - wordA.length || wordA.localeCompare(wordB);
  });
  const selected = [];

  for (const [word] of ranked) {
    const isChineseFragment = /[\p{Script=Han}]/u.test(word) && selected.some((existing) => existing.includes(word));
    if (!isChineseFragment) {
      selected.push(word);
    }
    if (selected.length === 6) {
      break;
    }
  }

  return selected;
}

function confidenceFor({ methods, findings, limitations, abstract, sentenceCount }) {
  let score = 0;
  const rationale = [];

  if (methods.length > 0) {
    score += 2;
    rationale.push('摘要说明了研究方法');
  }
  if (findings.length > 0) {
    score += 2;
    rationale.push('摘要报告了主要结果');
  }
  if (limitations.length > 0) {
    score += 1;
    rationale.push('摘要主动披露了局限');
  }
  if (/\d|%|百分|significant|confidence interval|p\s*[<=>]/iu.test(abstract)) {
    score += 1;
    rationale.push('包含定量证据线索');
  }
  if (sentenceCount >= 4) {
    score += 1;
    rationale.push('摘要信息较完整');
  }

  return {
    score,
    label: score >= 5 ? '较强' : score >= 3 ? '中等' : '初步',
    rationale,
  };
}

function createFollowUpQuestions({ methods, findings, limitations, abstract }) {
  const questions = ['样本与研究对象是否能代表你关心的人群或情境？'];

  if (/随机|randomi[sz]ed|对照|controlled trial/iu.test(abstract)) {
    questions.push('随机化、盲法和对照组的执行质量如何，是否存在失访偏差？');
  } else if (methods.length > 0) {
    questions.push('这个研究设计能支持因果结论，还是只能说明相关性？');
  } else {
    questions.push('摘要没有交代方法：样本、测量和分析步骤分别是什么？');
  }

  if (/\d|%|百分|significant|p\s*[<=>]/iu.test(findings.join(' '))) {
    questions.push('报告的效应量是否具有实际意义，而不只是统计显著？');
  } else {
    questions.push('主要结论是否有具体效应量、不确定性区间或原始数据支撑？');
  }

  questions.push(
    limitations.length > 0
      ? '作者披露的局限之外，还有哪些未测量混杂或替代解释？'
      : '摘要没有明确披露局限：哪些边界条件可能让结论失效？',
  );

  return questions;
}

function markdownList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function createMarkdown(result) {
  return [
    `# ${result.title}`,
    '',
    `> 阅读把握：${result.readingConfidence.label}（${result.readingConfidence.score}/7）`,
    '',
    '## 研究问题',
    '',
    result.researchQuestion,
    '',
    '## 方法',
    '',
    markdownList(result.methods),
    '',
    '## 主要发现',
    '',
    markdownList(result.findings),
    '',
    '## 局限',
    '',
    markdownList(result.limitations),
    '',
    '## 关键词',
    '',
    result.keywords.join(' · '),
    '',
    '## 精读时继续追问',
    '',
    markdownList(result.followUpQuestions),
  ].join('\n');
}

export function analyzeLiterature(input) {
  const title = input?.title?.trim() || '未命名文献';
  const abstract = input?.abstract?.trim() ?? '';

  if (abstract.length < MIN_ABSTRACT_LENGTH) {
    throw new LiteratureInputError(
      'ABSTRACT_TOO_SHORT',
      `为了避免凭空概括，请至少输入 ${MIN_ABSTRACT_LENGTH} 个字符的摘要。`,
    );
  }

  const sentences = splitSentences(abstract);
  const matchedQuestion = selectSentences(sentences, SIGNALS.question, 1);
  const methods = selectSentences(sentences, SIGNALS.methods, 3);
  const findings = selectSentences(sentences, SIGNALS.findings, 3);
  const limitations = selectSentences(sentences, SIGNALS.limitations, 3);

  const result = {
    title,
    wordCount: countWords(abstract),
    readingConfidence: confidenceFor({
      methods,
      findings,
      limitations,
      abstract,
      sentenceCount: sentences.length,
    }),
    researchQuestion: matchedQuestion[0] ?? `摘要没有直接陈述研究问题；首句线索是：“${sentences[0]}”`,
    methods: methods.length > 0 ? methods : ['摘要没有明确说明研究设计、样本或分析方法。'],
    findings: findings.length > 0 ? findings : ['摘要没有明确报告可核查的主要发现。'],
    limitations: limitations.length > 0 ? limitations : ['摘要没有主动披露研究局限或适用边界。'],
    keywords: extractKeywords(title, abstract),
  };

  result.followUpQuestions = createFollowUpQuestions({
    methods,
    findings,
    limitations,
    abstract,
  });
  result.markdown = createMarkdown(result);

  return result;
}
