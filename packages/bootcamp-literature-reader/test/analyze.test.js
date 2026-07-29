import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeLiterature, LiteratureInputError } from '../src/analyze.js';

const chineseAbstract = [
  '城市热岛效应正在增加居民的夏季热暴露风险。',
  '本研究旨在评估城市绿地密度是否能够降低夏季地表温度。',
  '研究采用2019年至2023年的卫星遥感数据，并对36个城区建立固定效应回归模型。',
  '结果显示，绿地覆盖率每增加10个百分点，午后地表温度平均下降0.8摄氏度。',
  '该关联在高密度居住区更明显。',
  '但样本仅覆盖一座城市，遥感温度也不能完全代表个体热暴露。',
  '未来研究需要结合多城市数据和可穿戴传感器进行验证。',
].join('');

describe('analyzeLiterature', () => {
  it('extracts a structured brief from a Chinese abstract', () => {
    const result = analyzeLiterature({
      title: '城市绿地与夏季地表温度：一项纵向研究',
      abstract: chineseAbstract,
    });

    assert.match(result.researchQuestion, /城市绿地密度/);
    assert.ok(result.methods.some((sentence) => sentence.includes('固定效应回归模型')));
    assert.ok(result.findings.some((sentence) => sentence.includes('平均下降0.8摄氏度')));
    assert.ok(result.limitations.some((sentence) => sentence.includes('样本仅覆盖一座城市')));
    assert.ok(result.keywords.some((keyword) => ['城市', '绿地'].includes(keyword)));
    assert.equal(result.readingConfidence.label, '较强');
    assert.ok(result.followUpQuestions.length >= 3);
  });

  it('classifies common method and result signals in English abstracts', () => {
    const result = analyzeLiterature({
      title: 'Sleep duration and memory consolidation',
      abstract: [
        'This study investigates whether sleep duration improves memory consolidation in adults.',
        'We conducted a randomized controlled trial with 240 participants and measured recall after seven days.',
        'Results showed that the eight-hour group recalled significantly more items than the control group.',
        'However, the sample came from one university and the follow-up period was short.',
      ].join(' '),
    });

    assert.match(result.researchQuestion, /investigates whether/i);
    assert.ok(result.methods.some((sentence) => /randomized controlled trial/i.test(sentence)));
    assert.ok(result.findings.some((sentence) => /significantly more/i.test(sentence)));
    assert.ok(result.limitations.some((sentence) => /one university/i.test(sentence)));
    assert.ok(result.keywords.includes('memory'));
  });

  it('rejects abstracts that are too short to analyze responsibly', () => {
    assert.throws(
      () => analyzeLiterature({ title: '短摘要', abstract: '结果很好。' }),
      (error) => {
        assert.ok(error instanceof LiteratureInputError);
        assert.equal(error.code, 'ABSTRACT_TOO_SHORT');
        assert.match(error.message, /至少输入/);
        return true;
      },
    );
  });

  it('filters generic stop words from keywords', () => {
    const result = analyzeLiterature({
      title: 'A practical evaluation of retrieval systems',
      abstract: [
        'This study evaluates retrieval systems for scientific documents.',
        'The method compares semantic retrieval with a lexical baseline across twelve datasets.',
        'The results show improved precision for semantic retrieval.',
        'However, the evaluation excludes multilingual documents and future work should test them.',
      ].join(' '),
    });

    assert.ok(result.keywords.includes('retrieval'));
    assert.ok(!result.keywords.includes('this'));
    assert.ok(!result.keywords.includes('study'));
  });

  it('keeps useful Chinese title phrases and removes connective filler', () => {
    const result = analyzeLiterature({
      title: '远程办公与团队创造力',
      abstract:
        '本研究旨在评估远程办公频率与团队创造力之间的关系。研究采用来自42个产品团队的半年追踪数据，并使用多层回归模型分析协作日志与创意评分。结果显示，每周两天远程办公与更高的创意评分相关，但完全远程团队没有出现同样优势。样本仅来自科技企业，观察性设计也不能证明因果关系。未来研究需要在更多行业开展随机或准实验验证。',
    });

    assert.ok(result.keywords.includes('远程办公'));
    assert.ok(result.keywords.includes('团队创造力'));
    assert.ok(!result.keywords.includes('远程'));
    assert.ok(!result.keywords.includes('办公'));
    assert.ok(!result.keywords.includes('来自'));
    assert.ok(!result.keywords.includes('也不能'));
  });

  it('exports the brief as readable Markdown', () => {
    const result = analyzeLiterature({
      title: '城市绿地与夏季地表温度：一项纵向研究',
      abstract: chineseAbstract,
    });

    assert.match(result.markdown, /^# 城市绿地与夏季地表温度：一项纵向研究/m);
    assert.match(result.markdown, /## 研究问题/);
    assert.match(result.markdown, /## 方法/);
    assert.match(result.markdown, /## 局限/);
    assert.doesNotMatch(result.markdown, /undefined/);
  });
});
