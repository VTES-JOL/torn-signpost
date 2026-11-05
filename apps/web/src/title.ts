/**
 * The tab title: "(3) ● Torn Signpost" — unread notifications (NOTIF-01), then ● while the table
 * waits on you (UX-09). Both are set from different places, so the title is built here.
 */
const parts = { unread: 0, waiting: false };
let base: string | undefined;

function render() {
  base ??= document.title;
  const count = parts.unread ? `(${parts.unread > 49 ? '50+' : parts.unread}) ` : '';
  document.title = `${count}${parts.waiting ? '● ' : ''}${base}`;
}

export function setUnreadTitle(unread: number) {
  parts.unread = unread;
  render();
}

export function setWaitingTitle(waiting: boolean) {
  parts.waiting = waiting;
  render();
}
