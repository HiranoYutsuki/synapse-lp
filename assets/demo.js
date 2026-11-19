(() => {
  'use strict';
  const $ = id => document.getElementById(`demo-${id}`);
  const ui = Object.fromEntries(['app','name','badge','run','panel','message','char-count','sample','rules','back','run-title','run-status','thinking','result','review','approve','revise','reject','revise-form','revise-text','revise-send','revise-cancel','done','copy','again','error','quota'].map(id => [id, $(id)]));
  const blocks = [...ui.app.querySelectorAll('.wf-block')];
  const panes = Object.fromEntries([...ui.app.querySelectorAll('.wf-pane')].map(pane => [pane.dataset.pane, pane]));
  const sample = '以下は架空の会議メモです。\n\n9月24日 営業定例\n参加：佐藤・田中・鈴木\n新サービスの紹介資料は、専門用語を減らして3ページにする。\n田中が9月27日までに初稿を作成。佐藤が9月28日に確認。\n鈴木は既存顧客5社へヒアリングする。期限はまだ未定。\n次回の会議でヒアリング結果を共有する。';
  const small = matchMedia('(max-width: 760px)');
  let phase = 'idle';            // idle | running | review | revising | done | rejected
  let history = [];
  let lastAnswer = '';
  let configured = false, globalAvailable = true, remaining = 10, limit = 10, refreshAt = 0;

  function step(n) {
    for (let i = 1; i <= 3; i++) {
      const li = $(`step-${i}`);
      li.classList.toggle('is-current', i === n);
      li.classList.toggle('is-complete', i < n);
      if (i === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    }
  }
  function error(text = '') { ui.error.textContent = text; ui.error.hidden = !text; }
  function setState(block, state, label) {
    const el = ui.app.querySelector(`.wf-block[data-block="${block}"] [data-state]`);
    el.className = 'wf-state' + (state ? ` is-${state}` : ''); el.textContent = label || '';
  }
  function states(map) { for (const b of ['trigger','input','ai','review','output']) setState(b, ...(map[b] || [])); }
  function select(name) {
    blocks.forEach(b => { const on = b.dataset.block === name; b.classList.toggle('is-selected', on); b.setAttribute('aria-pressed', String(on)); });
    for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== name;
  }
  function busy() { return phase === 'running'; }
  function update() {
    const ready = configured && globalAvailable && remaining > 0;
    ui.run.disabled = busy() || !ready;
    ui['revise-send'].disabled = busy() || !ready;
    [ui.name, ui.rules, ui.message, ui.sample].forEach(el => { el.disabled = busy(); });
    ui['char-count'].textContent = `${ui.message.value.length} / 500`;
    ui.quota.textContent = configured ? (globalAvailable ? `本日のテスト実行：あと ${remaining} / ${limit} 回` : '本日の受付は終了しました') : 'AIへの接続準備中';
  }
  function quota(data) {
    if (Number.isInteger(data.remaining)) remaining = data.remaining;
    if (Number.isInteger(data.limit)) limit = data.limit;
    if (typeof data.globalAvailable === 'boolean') globalAvailable = data.globalAvailable;
    update();
  }
  function showRun(title, status) {
    ui['run-title'].textContent = title; ui['run-status'].textContent = status || '';
    select('run');
    if (small.matches) ui.panel.scrollIntoView({ block:'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function view(kind) {
    ui.thinking.hidden = kind !== 'thinking';
    ui.result.hidden = !lastAnswer || kind === 'thinking' && !lastAnswer;
    ui.review.hidden = kind !== 'review';
    ui['revise-form'].hidden = kind !== 'revise';
    ui.done.hidden = kind !== 'done';
    ui.back.hidden = kind === 'thinking';
  }

  // ---- block selection ----
  blocks.forEach(block => block.addEventListener('click', () => { if (!busy()) { error(); select(block.dataset.block); } }));
  ui.back.addEventListener('click', () => select('input'));
  ui.sample.addEventListener('click', () => { ui.message.value = sample; update(); ui.message.focus(); });
  ui.message.addEventListener('input', update);

  // ---- one call to the local server per run / revision ----
  async function generate(message, title) {
    const name = ui.name.value.trim(), rules = ui.rules.value.trim();
    if (!name) { error('AIエージェントの名前を入力してください。'); ui.name.focus(); return; }
    if (!rules) { error('#2 AI処理の「AIへの指示」を入力してください。'); select('ai'); ui.rules.focus(); return; }
    phase = 'running'; error(); step(2); update();
    states({ trigger:['done','完了'], input:['done','完了'], ai:['running','実行中'] });
    showRun(title, '#2 AI処理を実行しています。');
    view('thinking'); ui.result.hidden = true;
    try {
      const response = await fetch('/api/chat', { method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ employee:{ name, rules }, message, history }), signal:AbortSignal.timeout(35000) });
      const data = await response.json(); quota(data);
      if (!response.ok) throw new Error(data.error || '実行できませんでした。もう一度お試しください。');
      if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('結果を取得できませんでした。もう一度お試しください。');
      lastAnswer = data.text;
      history.push({ role:'user', text:message }, { role:'model', text:data.text });
      while (history.length > 4 || history.reduce((n, item) => n + item.text.length, 0) > 4000) history.splice(0, 2);
      phase = 'review'; step(3);
      states({ trigger:['done','完了'], input:['done','完了'], ai:['done','完了'], review:['waiting','確認待ち'] });
      ui.result.textContent = data.text;
      ui['run-title'].textContent = '#3 人間の確認';
      ui['run-status'].textContent = data.truncated ? 'AIの下書きができました（文字数の上限で途中までになっています）。' : 'AIの下書きができました。内容を確認してください。';
      view('review'); ui.result.focus({ preventScroll:true });
    } catch (cause) {
      phase = lastAnswer ? 'review' : 'idle';
      error(cause.name === 'TimeoutError' ? '接続がタイムアウトしました。時間をおいてお試しください。' : cause.message === 'Failed to fetch' ? '接続できませんでした。サーバーの起動状態をご確認ください。' : cause.message);
      if (lastAnswer) { states({ trigger:['done','完了'], input:['done','完了'], ai:['done','完了'], review:['waiting','確認待ち'] }); ui['run-title'].textContent = '#3 人間の確認'; ui['run-status'].textContent = '前回の下書きを表示しています。'; view('review'); step(3); }
      else { states({}); ui['run-title'].textContent = '実行できませんでした'; ui['run-status'].textContent = ''; view('none'); ui.back.hidden = false; step(1); }
      await refreshSession();
    } finally {
      if (phase === 'running') phase = 'idle';
      update();
      if (remaining <= 0) error('本日のテスト実行回数を使い切りました。明日またお試しください。');
    }
  }
  function startRun() {
    if (busy()) return;
    const message = ui.message.value.trim();
    if (!message) { select('input'); error('#1 ユーザー入力に会議メモを入れてください。「サンプルの会議メモを入れる」も使えます。'); ui.message.focus(); return; }
    history = []; lastAnswer = '';
    generate(message, 'テスト実行');
  }
  ui.run.addEventListener('click', startRun);
  ui.again.addEventListener('click', startRun);

  // ---- 人間の確認: approve / ask for a revision / reject ----
  ui.approve.addEventListener('click', () => {
    phase = 'done'; step(4);
    states({ trigger:['done','完了'], input:['done','完了'], ai:['done','完了'], review:['done','承認済み'], output:['done','保存']});
    ui['run-title'].textContent = '#4 議事録を保存'; ui['run-status'].textContent = '承認されたので、議事録を保存しました（体験版ではこの画面に表示しています）。';
    ui.badge.textContent = 'テスト完了'; ui.badge.classList.add('is-live');
    view('done');
  });
  ui.revise.addEventListener('click', () => { phase = 'revising'; view('revise'); ui['revise-text'].focus(); });
  ui['revise-cancel'].addEventListener('click', () => { phase = 'review'; view('review'); });
  ui['revise-form'].addEventListener('submit', event => {
    event.preventDefault();
    const text = ui['revise-text'].value.trim();
    if (!text) { error('修正の指示を入力してください。'); return; }
    generate(text, '修正して再実行');
  });
  ui.reject.addEventListener('click', () => {
    phase = 'rejected'; step(1);
    states({ trigger:['done','完了'], input:['done','完了'], ai:['done','完了'], review:['rejected','却下'] });
    ui['run-title'].textContent = '却下しました'; ui['run-status'].textContent = '保存はされていません。指示やメモを見直して、もう一度テスト実行できます。';
    lastAnswer = ''; ui.result.textContent = ''; view('none'); ui.back.hidden = false;
  });
  ui.copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastAnswer); ui['run-status'].textContent = '議事録をコピーしました。'; }
    catch { ui['run-status'].textContent = '議事録の文章を選択してコピーしてください。'; }
  });

  // ---- quota / server status ----
  async function refreshSession() {
    try {
      const response = await fetch('/api/session', { cache:'no-store', credentials:'same-origin', signal:AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('offline');
      const data = await response.json(); configured = data.configured === true; quota(data); refreshAt = Date.now();
      if (!configured) error('AIへの接続準備中です。ローカルサーバーの設定をご確認ください。');
    } catch { configured = false; update(); error('AIに接続できません。起動用ファイルでローカルサーバーを起動してから、このページを開いてください。'); }
  }
  window.addEventListener('focus', () => { if (!busy() && Date.now() - refreshAt > 60000) refreshSession(); });
  (function refreshAtMidnight() {
    const japanNow = new Date(Date.now() + 9 * 3600000);
    const untilMidnight = 86400000 - (japanNow.getUTCHours() * 3600000 + japanNow.getUTCMinutes() * 60000 + japanNow.getUTCSeconds() * 1000);
    setTimeout(() => { if (!busy()) refreshSession(); refreshAtMidnight(); }, untilMidnight + 1000);
  })();
  select('input'); view('none'); update(); refreshSession();
})();
