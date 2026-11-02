// The frontend: one HTML page, its script and its stylesheet, served by this Worker. No build step
// and no framework, so it reads top to bottom; swap it for React, Vue or Svelte when the app grows
// (serve the build with `assets` in mdrn.jsonc and keep /api answered by the Worker first).
//
// Everything user-supplied goes into the page with textContent, never as HTML, and the page's
// Content-Security-Policy allows only this origin's own script and style.

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SaaS starter</title>
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<header><strong>SaaS starter</strong><span id="who"></span></header>
<main>
  <p id="message" role="status"></p>
  <section id="signed-out" hidden>
    <h1>Teams, invitations and settings</h1>
    <p>Sign in to create a team and invite people to it.</p>
    <a class="button" href="/login">Sign in</a>
  </section>
  <section id="signed-in" hidden>
    <aside>
      <h2>Your teams</h2>
      <ul id="teams"></ul>
      <form id="create-team"><input name="name" placeholder="New team name" maxlength="80" required><button>Create</button></form>
    </aside>
    <article id="team" hidden>
      <h2 id="team-name"></h2>
      <p class="muted" id="team-role"></p>
      <h3>Settings</h3>
      <form id="settings">
        <label>Name <input name="name" maxlength="80" required></label>
        <label>Description <textarea name="description" maxlength="500" rows="2"></textarea></label>
        <label>Time zone <input name="timezone" maxlength="64" required></label>
        <label class="check"><input type="checkbox" name="membersCanInvite"> Members can invite people</label>
        <button>Save settings</button>
      </form>
      <h3>Members</h3>
      <ul id="members"></ul>
      <h3>Invite someone</h3>
      <form id="invite">
        <input name="email" type="email" placeholder="name@example.com" required>
        <select name="role"><option value="member">Member</option><option value="admin">Admin</option></select>
        <button>Send invitation</button>
      </form>
      <p class="muted" id="invite-link"></p>
      <div id="pending"><h3>Pending invitations</h3><ul id="invites"></ul></div>
      <p><button id="delete-team" class="danger">Delete team</button></p>
    </article>
  </section>
</main>
</body>
</html>
`;

export const css = `
:root { color-scheme: light dark; --line: #8884; --accent: #3b5bdb; font: 15px/1.5 system-ui, sans-serif; }
body { margin: 0; }
header { display: flex; justify-content: space-between; gap: 1rem; padding: .75rem 1rem; border-bottom: 1px solid var(--line); }
main { max-width: 60rem; margin: 0 auto; padding: 1rem; }
#signed-in:not([hidden]) { display: grid; grid-template-columns: minmax(12rem, 1fr) 3fr; gap: 2rem; }
@media (max-width: 40rem) { #signed-in:not([hidden]) { grid-template-columns: 1fr; } }
ul { list-style: none; padding: 0; }
li { display: flex; align-items: center; gap: .5rem; padding: .35rem 0; border-bottom: 1px solid var(--line); }
li > :first-child { flex: 1; }
form { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0; }
#settings { flex-direction: column; max-width: 28rem; }
label { display: flex; flex-direction: column; gap: .25rem; }
label.check { flex-direction: row; align-items: center; }
input, select, textarea, button, .button { font: inherit; padding: .35rem .6rem; border: 1px solid var(--line); border-radius: 6px; }
button, .button { background: var(--accent); color: #fff; border-color: transparent; cursor: pointer; text-decoration: none; }
button.link { background: none; color: inherit; border-color: var(--line); }
button.danger { background: #c92a2a; }
li.active { font-weight: 600; }
.muted { opacity: .7; }
#message:empty { display: none; }
#message { padding: .5rem .75rem; border: 1px solid var(--line); border-radius: 6px; }
`;

export const js = `
const $ = selector => document.querySelector(selector);
const state = { me: null, teams: [], team: null };

function say(text) { $('#message').textContent = text || ''; }

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...init.headers } });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || 'Something went wrong.'), { status: response.status });
  return body;
}
const send = (method, path, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  Object.assign(node, attrs);
  return node;
}

async function attempt(work) {
  try { say(''); await work(); } catch (error) { say(error.message); }
}

async function loadTeams(selectId) {
  state.teams = (await api('/api/teams')).items;
  const list = $('#teams');
  list.replaceChildren(...state.teams.map(team => {
    const item = el('li');
    item.append(el('button', team.name, { className: 'link', onclick: () => attempt(() => openTeam(team.id)) }), el('span', team.role, { className: 'muted' }));
    if (team.id === state.team?.id) item.className = 'active';
    return item;
  }));
  const next = selectId ?? state.team?.id ?? state.teams[0]?.id;
  if (next && state.teams.some(team => team.id === next)) await openTeam(next);
  else { state.team = null; $('#team').hidden = true; }
}

async function openTeam(id) {
  const team = await api('/api/teams/' + id);
  state.team = team;
  for (const item of $('#teams').children) item.className = item.firstChild.textContent === team.name ? 'active' : '';
  $('#team').hidden = false;
  $('#team-name').textContent = team.name;
  $('#team-role').textContent = 'You are ' + (team.role === 'admin' ? 'an admin' : 'the ' + team.role) + ' of this team.';
  const admin = team.role !== 'member';
  const form = $('#settings');
  form.elements.name.value = team.name;
  form.elements.description.value = team.description;
  form.elements.timezone.value = team.timezone;
  form.elements.membersCanInvite.checked = team.membersCanInvite;
  for (const field of form.elements) field.disabled = !admin;
  $('#invite').hidden = !admin && !team.membersCanInvite;
  $('#invite').elements.role.disabled = !admin;
  $('#invite-link').textContent = '';
  $('#pending').hidden = !admin;
  $('#delete-team').hidden = team.role !== 'owner';
  await Promise.all([loadMembers(), admin ? loadInvites() : null]);
}

async function loadMembers() {
  const team = state.team;
  const members = (await api('/api/teams/' + team.id + '/members')).items;
  $('#members').replaceChildren(...members.map(member => {
    const item = el('li');
    const mine = member.userId === state.me.id;
    item.append(el('span', (member.email || member.userId) + (mine ? ' (you)' : '')));
    if (team.role === 'owner' && member.role !== 'owner') {
      const role = el('select');
      role.append(el('option', 'Member', { value: 'member' }), el('option', 'Admin', { value: 'admin' }));
      role.value = member.role;
      role.onchange = () => attempt(async () => { await send('PATCH', '/api/teams/' + team.id + '/members/' + member.id, { version: member.version, role: role.value }); await loadMembers(); });
      item.append(role);
    } else item.append(el('span', member.role, { className: 'muted' }));
    const removable = mine ? member.role !== 'owner' : member.role !== 'owner' && (team.role === 'owner' || (team.role === 'admin' && member.role === 'member'));
    if (removable) item.append(el('button', mine ? 'Leave' : 'Remove', { className: 'link', onclick: () => attempt(async () => {
      if (!confirm(mine ? 'Leave this team?' : 'Remove ' + (member.email || 'this member') + '?')) return;
      await send('DELETE', '/api/teams/' + team.id + '/members/' + member.id);
      if (mine) { state.team = null; await loadTeams(); } else await loadMembers();
    }) }));
    return item;
  }));
}

async function loadInvites() {
  const team = state.team;
  const invites = (await api('/api/teams/' + team.id + '/invites')).items;
  $('#invites').replaceChildren(...invites.map(invite => {
    const item = el('li');
    item.append(el('span', invite.email + ' as ' + invite.role), el('button', 'Revoke', { className: 'link', onclick: () => attempt(async () => {
      await send('DELETE', '/api/teams/' + team.id + '/invites/' + invite.id);
      await loadInvites();
    }) }));
    return item;
  }));
  if (!invites.length) $('#invites').append(el('li', 'None.', { className: 'muted' }));
}

$('#create-team').onsubmit = event => attempt(async () => {
  event.preventDefault();
  const team = await send('POST', '/api/teams', { name: event.target.elements.name.value });
  event.target.reset();
  await loadTeams(team.id);
});

$('#settings').onsubmit = event => attempt(async () => {
  event.preventDefault();
  const form = event.target;
  await send('PUT', '/api/teams/' + state.team.id + '/settings', {
    version: state.team.version, name: form.elements.name.value, description: form.elements.description.value,
    timezone: form.elements.timezone.value, membersCanInvite: form.elements.membersCanInvite.checked,
  });
  await loadTeams(state.team.id);
  say('Settings saved.');
});

$('#invite').onsubmit = event => attempt(async () => {
  event.preventDefault();
  const form = event.target;
  const result = await send('POST', '/api/teams/' + state.team.id + '/invites', { email: form.elements.email.value, role: form.elements.role.value });
  form.reset();
  say(result.mailed ? 'Invitation sent to ' + result.invite.email + '.' : result.note + ' Send them this link yourself.');
  $('#invite-link').textContent = result.mailed ? '' : result.link;
  if (state.team.role !== 'member') await loadInvites();
});

$('#delete-team').onclick = () => attempt(async () => {
  if (!confirm('Delete ' + state.team.name + ' for everyone? This cannot be undone.')) return;
  await send('DELETE', '/api/teams/' + state.team.id + '?version=' + state.team.version);
  state.team = null;
  await loadTeams();
});

async function signOut() {
  const { csrfToken } = await (await fetch('/_mdrn/v1/platform/csrf')).json();
  await fetch('/_mdrn/v1/auth/session', { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } });
  location.assign('/');
}

async function start() {
  // An invitation link: keep its token across the sign-in, which may leave this page.
  const invite = /^#invite=([A-Za-z0-9_.-]+)$/.exec(location.hash)?.[1];
  if (invite) { sessionStorage.setItem('invite', invite); history.replaceState(null, '', '/'); }
  try { state.me = await api('/api/me'); } catch (error) {
    if (error.status !== 401) return say(error.message);
    $('#signed-out').hidden = false;
    if (sessionStorage.getItem('invite')) say('Sign in to accept your invitation.');
    return;
  }
  $('#who').replaceChildren(el('span', (state.me.email || 'Signed in') + ' · data in ' + state.me.store + ' '), el('button', 'Sign out', { className: 'link', onclick: () => attempt(signOut) }));
  $('#signed-in').hidden = false;
  let selected;
  const token = sessionStorage.getItem('invite');
  if (token) {
    sessionStorage.removeItem('invite');
    await attempt(async () => { selected = (await send('POST', '/api/invites/accept', { token })).teamId; say('Invitation accepted. Welcome to the team.'); });
  }
  try { await loadTeams(selected); } catch (error) { say(error.message); }
}

start();
`;
