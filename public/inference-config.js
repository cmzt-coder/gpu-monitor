// 推理服务配置弹窗：负责管理员令牌、配置读取、表单编辑和原子保存。
// 密钥不会从 GET 接口返回；直接密钥留空时，服务端会保留原值。
import { t } from './i18n/index.js';

const TOKEN_KEY = 'gpu-monitor.infer-admin-token';

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function storeToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式或禁用存储时，令牌只保留在当前 JS 内存中
  }
}

function errorText(error) {
  const warnings = Array.isArray(error?.warnings) ? error.warnings : [];
  if (warnings.length > 0) {
    return `${error.message}：${warnings.map((item) => item.message).join('；')}`;
  }
  return error?.message || String(error);
}

export function createInferenceConfigController({ onSaved } = {}) {
  const refs = {
    dialog: document.getElementById('infer-config-dialog'),
    close: document.getElementById('infer-config-close'),
    auth: document.getElementById('infer-config-auth'),
    authForm: document.getElementById('infer-config-auth-form'),
    token: document.getElementById('infer-config-token'),
    unlock: document.getElementById('infer-config-unlock'),
    authMessage: document.getElementById('infer-config-auth-message'),
    main: document.getElementById('infer-config-main'),
    path: document.getElementById('infer-config-path'),
    reload: document.getElementById('infer-config-reload'),
    general: document.getElementById('infer-config-general'),
    list: document.getElementById('infer-config-list'),
    editor: document.getElementById('infer-config-editor'),
    add: document.getElementById('infer-config-add'),
    message: document.getElementById('infer-config-message'),
    foot: document.getElementById('infer-config-foot'),
    dirty: document.getElementById('infer-config-dirty'),
    cancel: document.getElementById('infer-config-cancel'),
    save: document.getElementById('infer-config-save'),
  };

  let token = readStoredToken();
  let remote = null;
  let draft = null;
  let selectedId = null;
  let dirty = false;
  let busy = false;

  function setMessage(target, text, tone = '') {
    target.textContent = text || '';
    target.dataset.tone = tone;
  }

  function updateDirty() {
    refs.dirty.textContent = dirty ? t('inferConfig.dirty') : t('inferConfig.clean');
    refs.dirty.dataset.tone = dirty ? 'warning' : '';
    refs.save.disabled = busy || !dirty;
  }

  function markDirty() {
    dirty = true;
    updateDirty();
  }

  function showAuth(message = '', tone = '') {
    refs.auth.hidden = false;
    refs.main.hidden = true;
    refs.foot.hidden = true;
    setMessage(refs.authMessage, message, tone);
    refs.token.focus();
  }

  function showMain() {
    refs.auth.hidden = true;
    refs.main.hidden = false;
    refs.foot.hidden = false;
  }

  async function request(method = 'GET', body = null) {
    const response = await fetch('/api/inference/config', {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.code = payload?.code || `http_${response.status}`;
      error.status = response.status;
      error.warnings = payload?.warnings || [];
      throw error;
    }
    return payload;
  }

  async function loadConfig() {
    if (!token) {
      showAuth();
      return;
    }
    busy = true;
    refs.unlock.disabled = true;
    setMessage(refs.authMessage, t('inferConfig.loading'));
    try {
      const payload = await request('GET');
      remote = payload;
      draft = clone(payload.config);
      selectedId = draft.services?.[0]?.id || null;
      dirty = false;
      storeToken(token);
      showMain();
      renderAll();
      setMessage(refs.message, '');
    } catch (error) {
      if (error.status === 401) {
        token = '';
        storeToken('');
        showAuth(t('inferConfig.auth.invalid'), 'error');
      } else if (error.status === 503 || error.code === 'admin_token_not_configured') {
        showAuth(t('inferConfig.auth.disabled'), 'error');
      } else {
        showAuth(errorText(error), 'error');
      }
    } finally {
      busy = false;
      refs.unlock.disabled = false;
      updateDirty();
    }
  }

  function currentService() {
    return draft?.services?.find((service) => service.id === selectedId) || null;
  }

  function serviceDisplayName(service, index) {
    return service.name || service.id || t('inferConfig.serviceFallback', { n: index + 1 });
  }

  function renderList() {
    refs.list.replaceChildren();
    const services = draft?.services || [];
    if (services.length === 0) {
      refs.list.appendChild(node('p', 'infer-config__empty', t('inferConfig.noServices')));
      return;
    }
    services.forEach((service, index) => {
      const button = node('button', 'infer-config__item');
      button.type = 'button';
      button.setAttribute('role', 'listitem');
      button.dataset.selected = service.id === selectedId ? 'true' : 'false';
      const title = node('strong', '', serviceDisplayName(service, index));
      const meta = node('span', '', service.baseUrl || t('inferConfig.noAddress'));
      const auth = node('small', '', service.authType === 'direct'
        ? t('inferConfig.auth.direct')
        : service.authType === 'env' ? t('inferConfig.auth.env') : t('inferConfig.auth.none'));
      button.append(title, meta, auth);
      button.addEventListener('click', () => {
        selectedId = service.id;
        renderList();
        renderEditor();
      });
      refs.list.appendChild(button);
    });
  }

  function field(label, control, hint = '') {
    const wrap = node('label', 'infer-config__field');
    wrap.appendChild(node('span', 'infer-config__label', label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(node('small', 'infer-config__hint', hint));
    return wrap;
  }

  function textInput(value, onInput, { type = 'text', placeholder = '', autocomplete = 'off' } = {}) {
    const input = node('input', 'input');
    input.type = type;
    input.value = value ?? '';
    input.placeholder = placeholder;
    input.autocomplete = autocomplete;
    input.addEventListener('input', () => {
      onInput(input.value);
      markDirty();
      if (type !== 'password' && input.closest('.infer-config__editor')) renderList();
    });
    return input;
  }

  function checkInput(checked, onChange, labelText) {
    const label = node('label', 'infer-config__check');
    const input = node('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.addEventListener('change', () => {
      onChange(input.checked);
      markDirty();
    });
    label.append(input, node('span', '', labelText));
    return label;
  }

  function renderGeneral() {
    refs.general.replaceChildren();
    const enabled = checkInput(draft.enabled !== false, (value) => { draft.enabled = value; }, t('inferConfig.enabled'));
    const interval = textInput(draft.interval ?? '15s', (value) => { draft.interval = value; }, { placeholder: '15s' });
    const timeout = textInput(draft.timeoutMs ?? 3000, (value) => { draft.timeoutMs = Number(value) || 0; }, { type: 'number' });
    refs.general.append(
      enabled,
      field(t('inferConfig.interval'), interval, t('inferConfig.intervalHint')),
      field(t('inferConfig.timeout'), timeout, t('inferConfig.timeoutHint')),
    );
  }

  function ensureProbe(service) {
    service.probe = service.probe && typeof service.probe === 'object' ? service.probe : {};
    return service.probe;
  }

  function renderEditor() {
    refs.editor.replaceChildren();
    const service = currentService();
    if (!service) {
      refs.editor.appendChild(node('div', 'infer-config__empty infer-config__empty--editor', t('inferConfig.selectService')));
      return;
    }

    const head = node('div', 'infer-config__editor-head');
    const titleWrap = node('div');
    titleWrap.append(
      node('h3', '', serviceDisplayName(service, draft.services.indexOf(service))),
      node('p', '', service.baseUrl || t('inferConfig.noAddress')),
    );
    const remove = node('button', 'btn btn--ghost btn--sm infer-config__danger', t('inferConfig.delete'));
    remove.type = 'button';
    remove.addEventListener('click', () => {
      if (!window.confirm(t('inferConfig.confirmDelete', { name: serviceDisplayName(service, 0) }))) return;
      draft.services = draft.services.filter((item) => item !== service);
      selectedId = draft.services[0]?.id || null;
      markDirty();
      renderList();
      renderEditor();
    });
    head.append(titleWrap, remove);

    const basic = node('div', 'infer-config__section');
    basic.appendChild(node('h4', '', t('inferConfig.section.basic')));
    const grid = node('div', 'infer-config__grid');
    grid.append(
      field(t('inferConfig.field.id'), textInput(service.id, (value) => { service.id = value.trim(); selectedId = value.trim(); })),
      field(t('inferConfig.field.name'), textInput(service.name, (value) => { service.name = value; })),
      field(t('inferConfig.field.baseUrl'), textInput(service.baseUrl, (value) => { service.baseUrl = value.trim(); }, { placeholder: 'http://127.0.0.1:8000' })),
      field(t('inferConfig.field.model'), textInput(service.model, (value) => { service.model = value.trim(); })),
    );
    const kind = node('select', 'input');
    for (const value of ['chat', 'completions', 'embeddings', 'rerank']) {
      const option = node('option', '', t(`inferConfig.kind.${value}`));
      option.value = value;
      option.selected = (service.kind || 'chat') === value;
      kind.appendChild(option);
    }
    kind.addEventListener('change', () => {
      service.kind = kind.value;
      markDirty();
      renderEditor();
    });
    grid.append(
      field(t('inferConfig.field.kind'), kind),
      field(t('inferConfig.field.maxConcurrency'), textInput(service.maxConcurrency ?? '', (value) => { service.maxConcurrency = value === '' ? null : Number(value); }, { type: 'number' })),
    );
    basic.appendChild(grid);

    const auth = node('div', 'infer-config__section');
    auth.appendChild(node('h4', '', t('inferConfig.section.auth')));
    const modes = node('div', 'infer-config__modes');
    for (const mode of ['none', 'env', 'direct']) {
      const label = node('label', 'infer-config__mode');
      const radio = node('input');
      radio.type = 'radio';
      radio.name = 'infer-config-auth-type';
      radio.value = mode;
      radio.checked = (service.authType || 'none') === mode;
      radio.addEventListener('change', () => {
        service.authType = mode;
        markDirty();
        renderList();
        renderEditor();
      });
      label.append(radio, node('span', '', t(`inferConfig.auth.${mode}`)));
      modes.appendChild(label);
    }
    auth.appendChild(modes);
    if (service.authType === 'env') {
      const configured = service.apiKeyEnvConfigured === true;
      auth.appendChild(field(
        t('inferConfig.field.apiKeyEnv'),
        textInput(service.apiKeyEnv, (value) => { service.apiKeyEnv = value.trim(); }, { placeholder: 'STARTLUX_API_KEY' }),
        configured ? t('inferConfig.auth.envConfigured') : t('inferConfig.auth.envMissing'),
      ));
    } else if (service.authType === 'direct') {
      const saved = Boolean(service.apiKeySet);
      auth.appendChild(field(
        t('inferConfig.field.apiKey'),
        textInput(service.apiKey || '', (value) => { service.apiKey = value; }, {
          type: 'password',
          autocomplete: 'new-password',
          placeholder: saved ? t('inferConfig.auth.directSaved') : t('inferConfig.auth.directPlaceholder'),
        }),
        t('inferConfig.auth.directHint'),
      ));
    }

    const advanced = node('details', 'infer-config__advanced');
    advanced.appendChild(node('summary', '', t('inferConfig.section.advanced')));
    const paths = node('div', 'infer-config__grid');
    service.paths = service.paths && typeof service.paths === 'object' ? service.paths : {};
    for (const key of ['health', 'models', 'metrics']) {
      paths.appendChild(field(t(`inferConfig.path.${key}`), textInput(service.paths[key], (value) => { service.paths[key] = value; }, { placeholder: `/${key}` })));
    }
    advanced.appendChild(paths);

    const headersText = service._headersText ?? JSON.stringify(service.headers || {}, null, 2);
    const headersInput = node('textarea', 'input infer-config__textarea');
    headersInput.rows = 3;
    headersInput.value = headersText;
    headersInput.spellcheck = false;
    headersInput.addEventListener('input', () => {
      service._headersText = headersInput.value;
      markDirty();
    });
    advanced.appendChild(field(t('inferConfig.headers'), headersInput, t('inferConfig.headersHint')));

    const probe = ensureProbe(service);
    const probeSection = node('div', 'infer-config__subsection');
    probeSection.appendChild(checkInput(probe.enabled === true, (value) => { probe.enabled = value; }, t('inferConfig.probe.enabled')));
    const probeGrid = node('div', 'infer-config__grid');
    probeGrid.append(
      field(t('inferConfig.probe.interval'), textInput(probe.interval ?? '10m', (value) => { probe.interval = value; }, { placeholder: '10m' })),
      field(t('inferConfig.probe.timeout'), textInput(probe.timeoutMs ?? 60000, (value) => { probe.timeoutMs = Number(value) || 0; }, { type: 'number' })),
      field(t('inferConfig.probe.startupGrace'), textInput(probe.startupGrace ?? '5m', (value) => { probe.startupGrace = value; }, { placeholder: '5m' })),
      field(t('inferConfig.probe.maxTokens'), textInput(probe.maxTokens ?? 32, (value) => { probe.maxTokens = Number(value) || 0; }, { type: 'number' })),
    );
    if (['chat', 'completions'].includes(service.kind || 'chat')) {
      probeGrid.appendChild(field(t('inferConfig.probe.prompt'), textInput(probe.prompt ?? 'ping', (value) => { probe.prompt = value; })));
    } else if (service.kind === 'embeddings') {
      probeGrid.appendChild(field(t('inferConfig.probe.input'), textInput(probe.input ?? 'ping', (value) => { probe.input = value; })));
    } else if (service.kind === 'rerank') {
      probeGrid.appendChild(field(t('inferConfig.probe.query'), textInput(probe.query ?? 'ping', (value) => { probe.query = value; })));
    }
    probeSection.appendChild(probeGrid);
    if (service.kind === 'rerank') {
      const documents = node('textarea', 'input infer-config__textarea');
      documents.rows = 3;
      documents.value = Array.isArray(probe.documents) ? probe.documents.join('\n') : 'pong';
      documents.addEventListener('input', () => {
        probe.documents = documents.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
        markDirty();
      });
      probeSection.appendChild(field(t('inferConfig.probe.documents'), documents, t('inferConfig.probe.documentsHint')));
    }
    const checks = node('div', 'infer-config__checks');
    checks.append(
      checkInput(probe.idleOnly !== false, (value) => { probe.idleOnly = value; }, t('inferConfig.probe.idleOnly')),
      checkInput(probe.warmup !== false, (value) => { probe.warmup = value; }, t('inferConfig.probe.warmup')),
      checkInput(probe.stream !== false, (value) => { probe.stream = value; }, t('inferConfig.probe.stream')),
    );
    probeSection.appendChild(checks);
    advanced.appendChild(probeSection);

    refs.editor.append(head, basic, auth, advanced);
  }

  function renderAll() {
    refs.path.textContent = remote?.path || '';
    refs.reload.textContent = remote?.runtime?.autoReload
      ? t('inferConfig.autoReloadOn')
      : t('inferConfig.autoReloadOff');
    renderGeneral();
    renderList();
    renderEditor();
    updateDirty();
  }

  function payloadConfig() {
    const services = (draft.services || []).map((service) => {
      const next = clone(service);
      if (Object.prototype.hasOwnProperty.call(next, '_headersText')) {
        try {
          next.headers = next._headersText.trim() ? JSON.parse(next._headersText) : {};
        } catch (error) {
          throw new Error(t('inferConfig.headersInvalid', { id: next.id, message: error.message }));
        }
        delete next._headersText;
      }
      delete next.apiKeySet;
      delete next.apiKeyEnvConfigured;
      if (next.authType === 'direct') {
        delete next.apiKeyEnv;
        if (typeof next.apiKey !== 'string' || !next.apiKey.trim()) delete next.apiKey;
      } else if (next.authType === 'env') {
        delete next.apiKey;
      } else {
        delete next.apiKey;
        delete next.apiKeyEnv;
      }
      return next;
    });
    return { ...draft, services };
  }

  async function save() {
    if (busy || !dirty) return;
    busy = true;
    updateDirty();
    setMessage(refs.message, t('inferConfig.saving'));
    try {
      const payload = await request('PUT', { revision: remote.revision, config: payloadConfig() });
      remote = { ...remote, ...payload, runtime: payload.runtime || remote.runtime };
      draft = clone(payload.config);
      selectedId = draft.services?.some((service) => service.id === selectedId)
        ? selectedId
        : (draft.services?.[0]?.id || null);
      dirty = false;
      renderAll();
      setMessage(refs.message, t('inferConfig.saved'), 'success');
      onSaved?.(payload);
    } catch (error) {
      setMessage(refs.message, errorText(error), 'error');
    } finally {
      busy = false;
      updateDirty();
    }
  }

  function addService() {
    const used = new Set((draft.services || []).map((service) => service.id));
    let index = 1;
    while (used.has(`service-${index}`)) index += 1;
    const service = {
      id: `service-${index}`,
      name: t('inferConfig.newService', { n: index }),
      baseUrl: 'http://127.0.0.1:8000',
      model: '',
      kind: 'chat',
      maxConcurrency: null,
      authType: 'none',
      paths: { health: '/health', models: '/v1/models', metrics: '/metrics' },
      headers: {},
      probe: { enabled: false, interval: '10m', timeoutMs: 60000, idleOnly: true, startupGrace: '5m', warmup: true, stream: true, maxTokens: 32, prompt: 'ping' },
    };
    draft.services.push(service);
    selectedId = service.id;
    markDirty();
    renderList();
    renderEditor();
  }

  function close() {
    if (dirty && !window.confirm(t('inferConfig.discard'))) return;
    refs.dialog.close();
  }

  refs.authForm.addEventListener('submit', (event) => {
    event.preventDefault();
    token = refs.token.value.trim();
    if (!token) {
      setMessage(refs.authMessage, t('inferConfig.auth.required'), 'error');
      return;
    }
    loadConfig();
  });
  refs.close.addEventListener('click', close);
  refs.cancel.addEventListener('click', close);
  refs.add.addEventListener('click', addService);
  refs.save.addEventListener('click', save);
  refs.dialog.addEventListener('cancel', (event) => {
    if (dirty && !window.confirm(t('inferConfig.discard'))) event.preventDefault();
  });

  return {
    open() {
      if (!refs.dialog.open) refs.dialog.showModal();
      if (token) loadConfig();
      else showAuth();
    },
    refresh() {
      if (!refs.dialog.open) return;
      if (!refs.main.hidden && draft) renderAll();
    },
    close,
  };
}
