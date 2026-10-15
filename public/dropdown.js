/**
 * 顶栏那两个开关（展示模式 / 界面语言）的自绘下拉。
 *
 * 为什么不用原生 <select>：展开面板由系统绘制——macOS 那块半透明圆角面板、系统勾选、
 * 系统字体与高亮色，圆角/阴影/选中样式一个都改不了，混在页面里像另一个软件。
 * 而"收起态只占一行"这个好处要保留（英文下比按钮组省 100px 左右），所以自己实现一个 listbox。
 *
 * 交互与语义按 ARIA APG 的 "listbox popup（把焦点移进弹层）"：
 *   按钮：aria-haspopup="listbox" + aria-expanded + aria-controls
 *   弹层：role="listbox"，选项 role="option" + aria-selected；关闭时用 hidden 属性
 *   键盘：Enter / Space / ↓ 打开；↑ ↓ / Home / End 移动；Enter / Space 选中；
 *         Esc 关闭并把焦点还给按钮；Tab 关闭（浏览器继续走自己的 focus 顺序）
 *   鼠标：点选项选中；点弹层外部关闭；悬停与键盘高亮共用同一个 activeIndex，不会互相打架
 *
 * 这个模块只碰 DOM，不含业务判断；`stepIndex` 单独导出，便于冒烟测试直接覆盖环绕逻辑。
 */

/**
 * 键盘移动后的目标下标（纯函数，可单测）。
 * current < 0 表示"还没有高亮项"：向下取第一个，向上取最后一个。
 * 超出两端时环绕，永远不会返回 -1（除非根本没有选项）。
 */
export function stepIndex(current, delta, count) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (current < 0 || current >= count) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** 选项显示的文字：优先取里面带 data-i18n 的那个 span（它由 applyStaticI18n 翻译） */
function optionText(option) {
  const label = option.querySelector('[data-i18n], .dropdown__label') || option;
  return label.textContent.trim();
}

let uid = 0;

/**
 * 把一段静态结构变成可用的下拉。
 *
 * 结构约定（见 index.html）：
 *   <div class="dropdown" id="…">
 *     <button class="dropdown__button" aria-haspopup="listbox" aria-expanded="false">
 *       <span class="dropdown__value">收起时显示的文字（由本模块写）</span>
 *       <span class="dropdown__caret" aria-hidden="true"></span>
 *     </button>
 *     <ul class="dropdown__list" role="listbox" hidden>
 *       <li class="dropdown__option" role="option" data-value="…"><span data-i18n="…">文字</span></li>
 *     </ul>
 *   </div>
 *
 * 注意：本模块**不写选项文字**，只改 aria-selected / hidden / class——选项里的
 * data-i18n 由 applyStaticI18n 负责，这样才不会踩到"JS 重写的节点不许挂 data-i18n"那条规矩。
 * 按钮上那个"当前值"由本模块写，所以它不带 data-i18n。
 */
export function enhanceDropdown(root, { onChange } = {}) {
  if (!root) return null;
  const button = root.querySelector('.dropdown__button');
  const list = root.querySelector('.dropdown__list');
  const valueNode = root.querySelector('.dropdown__value');
  const options = [...root.querySelectorAll('.dropdown__option')];
  if (!button || !list || !valueNode || options.length === 0) return null;

  const listId = list.id || `${root.id || 'dropdown'}-list-${(uid += 1)}`;
  list.id = listId;
  button.setAttribute('aria-controls', listId);
  for (const option of options) {
    option.tabIndex = -1;
    if (!option.id) option.id = `${listId}-opt-${(uid += 1)}`;
  }

  let activeIndex = -1;

  const selectedIndex = () => options.findIndex((option) => option.getAttribute('aria-selected') === 'true');
  const isOpen = () => !list.hidden;

  function setActive(index) {
    if (index < 0 || index >= options.length) return;
    activeIndex = index;
    // 键盘移动时把焦点也带过去：读屏会念出"第 N 项，共 M 项"
    options[index].focus();
  }

  function paint() {
    const index = selectedIndex();
    const current = index >= 0 ? index : 0;
    valueNode.textContent = optionText(options[current]);
  }

  function open(initialIndex = null) {
    if (isOpen()) return;
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const index = initialIndex ?? (selectedIndex() >= 0 ? selectedIndex() : 0);
    setActive(index);
  }

  function close({ focusButton = false } = {}) {
    if (!isOpen()) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
    if (focusButton) button.focus();
  }

  function select(index) {
    const option = options[index];
    if (!option) return;
    for (const item of options) {
      item.setAttribute('aria-selected', item === option ? 'true' : 'false');
    }
    paint();
    close({ focusButton: true });
    const value = option.dataset.value;
    if (typeof onChange === 'function') onChange(value);
  }

  button.addEventListener('click', () => {
    if (isOpen()) close();
    else open();
  });

  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(stepIndex(selectedIndex(), event.key === 'ArrowDown' ? 1 : -1, options.length));
    } else if (event.key === 'Enter' || event.key === ' ') {
      // 按钮自己会因点击而打开，这里只处理"焦点在按钮上按回车/空格"
      event.preventDefault();
      open();
    }
  });

  list.addEventListener('keydown', (event) => {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      setActive(stepIndex(activeIndex, key === 'ArrowDown' ? 1 : -1, options.length));
    } else if (key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (key === 'End') {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      select(activeIndex);
    } else if (key === 'Escape') {
      event.preventDefault();
      close({ focusButton: true });
    } else if (key === 'Tab') {
      // 让浏览器按自己的顺序把焦点移走，只负责把弹层收起来
      close();
    }
  });

  for (const [index, option] of options.entries()) {
    option.addEventListener('click', () => select(index));
    // 鼠标移到哪一项，键盘的"当前项"就跟到哪——否则按回车会选中另一个
    option.addEventListener('pointerenter', () => {
      activeIndex = index;
    });
  }

  // 点弹层和按钮以外的地方就收起。用捕获阶段，免得被其它点击处理器 stopPropagation 干扰
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!isOpen()) return;
      if (root.contains(event.target)) return;
      close();
    },
    true,
  );

  paint();

  return {
    root,
    /** 直接设值（不触发 onChange）：用于启动时对齐、以及切语言后重刷按钮上的文字 */
    setValue(value) {
      const index = options.findIndex((option) => option.dataset.value === value);
      if (index < 0) return false;
      for (const [i, option] of options.entries()) {
        option.setAttribute('aria-selected', i === index ? 'true' : 'false');
      }
      paint();
      return true;
    },
    getValue: () => options[selectedIndex()]?.dataset.value ?? null,
    /** 选项文字被翻译之后，按钮上那行也要跟着变（选项本身不重写） */
    refresh: paint,
    open,
    close,
    isOpen,
  };
}
