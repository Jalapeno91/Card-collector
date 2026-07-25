import { el } from '../ui.js';

let confirmAction = null;

export function openConfirm(title, body, action, opts){
  el('confirmTitle').textContent = title;
  el('confirmBody').textContent = body;
  const okBtn = el('confirmOk');
  okBtn.textContent = (opts && opts.okLabel) || 'Delete';
  okBtn.style.background = (opts && opts.okColor) || 'var(--rose)';
  confirmAction = action;
  el('confirmOverlay').classList.add('open');
}

el('confirmCancel').onclick = () => { el('confirmOverlay').classList.remove('open'); confirmAction = null; };
el('confirmOk').onclick = async () => {
  const a = confirmAction;
  el('confirmOverlay').classList.remove('open');
  confirmAction = null;
  if (a) await a();
};
