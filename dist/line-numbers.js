export function setupLineNumbers(textarea, gutter, measure) {
  const numbers = gutter.firstElementChild;
  let frame;
  function syncScroll() { numbers.style.transform = `translateY(${-textarea.scrollTop}px)`; }
  function highlight() {
    const line = textarea.value.slice(0, textarea.selectionStart).split('\n').length;
    numbers.querySelector('.active-line')?.classList.remove('active-line');
    numbers.children[line - 1]?.classList.add('active-line');
    document.getElementById('line-position').textContent = `第 ${line} 行 / 共 ${Math.max(1, numbers.children.length)} 行`;
  }
  function render() {
    const style = getComputedStyle(textarea);
    for (const property of ['font', 'letterSpacing', 'lineHeight', 'tabSize', 'wordBreak', 'overflowWrap', 'whiteSpace']) measure.style[property] = style[property];
    measure.style.width = `${textarea.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`;
    const lines = textarea.value.split('\n');
    const fragments = document.createDocumentFragment();
    for (const text of lines) {
      const row = document.createElement('div');
      row.textContent = text || '\u200b';
      fragments.append(row);
    }
    measure.replaceChildren(fragments);
    const heights = [...measure.children].map(row => row.getBoundingClientRect().height);
    const labels = document.createDocumentFragment();
    heights.forEach((height, i) => {
      const number = document.createElement('div');
      number.textContent = i + 1;
      number.style.height = `${height}px`;
      labels.append(number);
    });
    numbers.replaceChildren(labels);
    highlight(); syncScroll();
  }
  function update() { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); }
  textarea.addEventListener('input', update);
  textarea.addEventListener('scroll', syncScroll);
  for (const event of ['click', 'keyup', 'select', 'focus']) textarea.addEventListener(event, highlight);
  new ResizeObserver(update).observe(textarea);
  document.fonts.ready.then(update);
  update();
  return { update };
}
