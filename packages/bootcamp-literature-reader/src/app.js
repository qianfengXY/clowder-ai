import { analyzeLiterature, LiteratureInputError } from './analyze.js';

const sample = {
  title: '城市绿地与夏季地表温度：一项纵向研究',
  abstract: [
    '城市热岛效应正在增加居民的夏季热暴露风险。',
    '本研究旨在评估城市绿地密度是否能够降低夏季地表温度。',
    '研究采用2019年至2023年的卫星遥感数据，并对36个城区建立固定效应回归模型。',
    '结果显示，绿地覆盖率每增加10个百分点，午后地表温度平均下降0.8摄氏度。',
    '该关联在高密度居住区更明显。',
    '但样本仅覆盖一座城市，遥感温度也不能完全代表个体热暴露。',
    '未来研究需要结合多城市数据和可穿戴传感器进行验证。',
  ].join(''),
};

const elements = {
  form: document.querySelector('#reader-form'),
  title: document.querySelector('#paper-title'),
  abstract: document.querySelector('#paper-abstract'),
  characterCount: document.querySelector('#character-count'),
  status: document.querySelector('#form-status'),
  sampleButton: document.querySelector('#sample-button'),
  clearButton: document.querySelector('#clear-button'),
  copyButton: document.querySelector('#copy-button'),
  emptyState: document.querySelector('#empty-state'),
  brief: document.querySelector('#brief'),
  resultTitle: document.querySelector('#result-title'),
  confidenceLabel: document.querySelector('#confidence-label'),
  confidence: document.querySelector('#confidence'),
  wordCount: document.querySelector('#word-count'),
  signalCount: document.querySelector('#signal-count'),
  researchQuestion: document.querySelector('#research-question'),
  methodsList: document.querySelector('#methods-list'),
  findingsList: document.querySelector('#findings-list'),
  limitationsList: document.querySelector('#limitations-list'),
  keywordList: document.querySelector('#keyword-list'),
  followUpList: document.querySelector('#follow-up-list'),
};

let currentMarkdown = '';

function setStatus(message, type = 'error') {
  elements.status.textContent = message;
  elements.status.classList.toggle('success', type === 'success');
}

function renderList(container, items) {
  container.replaceChildren(
    ...items.map((item) => {
      const node = document.createElement('li');
      node.textContent = item;
      return node;
    }),
  );
}

function renderKeywords(keywords) {
  elements.keywordList.replaceChildren(
    ...keywords.map((keyword) => {
      const node = document.createElement('span');
      node.textContent = keyword;
      return node;
    }),
  );
}

function renderBrief(result) {
  elements.resultTitle.textContent = result.title;
  elements.confidenceLabel.textContent = result.readingConfidence.label;
  elements.confidence.title = result.readingConfidence.rationale.join('；');
  elements.wordCount.textContent = String(result.wordCount);
  elements.signalCount.textContent = String(result.methods.length + result.findings.length + result.limitations.length);
  elements.researchQuestion.textContent = result.researchQuestion;
  renderList(elements.methodsList, result.methods);
  renderList(elements.findingsList, result.findings);
  renderList(elements.limitationsList, result.limitations);
  renderKeywords(result.keywords);
  renderList(elements.followUpList, result.followUpQuestions);

  currentMarkdown = result.markdown;
  elements.emptyState.hidden = true;
  elements.brief.hidden = false;
  elements.copyButton.disabled = false;
}

function resetBrief() {
  currentMarkdown = '';
  elements.emptyState.hidden = false;
  elements.brief.hidden = true;
  elements.copyButton.disabled = true;
}

function updateCharacterCount() {
  elements.characterCount.textContent = `${elements.abstract.value.length} 字符`;
}

elements.abstract.addEventListener('input', updateCharacterCount);

elements.sampleButton.addEventListener('click', () => {
  elements.title.value = sample.title;
  elements.abstract.value = sample.abstract;
  updateCharacterCount();
  setStatus('示例已填入，可以直接生成简报。', 'success');
  elements.abstract.focus();
});

elements.clearButton.addEventListener('click', () => {
  elements.form.reset();
  updateCharacterCount();
  resetBrief();
  setStatus('');
  elements.title.focus();
});

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  setStatus('');

  try {
    const result = analyzeLiterature({
      title: elements.title.value,
      abstract: elements.abstract.value,
    });
    renderBrief(result);
    setStatus('阅读简报已生成。', 'success');

    if (window.matchMedia('(max-width: 980px)').matches) {
      elements.brief.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    resetBrief();
    const message = error instanceof LiteratureInputError ? error.message : '分析时发生了意外错误，请检查输入后重试。';
    setStatus(message);
    elements.abstract.focus();
  }
});

elements.copyButton.addEventListener('click', async () => {
  if (!currentMarkdown) {
    return;
  }

  try {
    await navigator.clipboard.writeText(currentMarkdown);
    elements.copyButton.textContent = '已复制';
    setStatus('Markdown 简报已复制到剪贴板。', 'success');
    window.setTimeout(() => {
      elements.copyButton.textContent = '复制 Markdown';
    }, 1600);
  } catch {
    setStatus('浏览器没有授予剪贴板权限，请在地址栏允许后重试。');
  }
});

updateCharacterCount();
