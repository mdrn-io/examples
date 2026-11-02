// The whole frontend: one page, its script and its style, served by the Worker as strings.
// The script builds every element with textContent, never innerHTML, and the page's
// Content-Security-Policy (src/index.ts) allows scripts and styles from this origin only.

export const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Short links</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<main>
<h1>Short links</h1>
<p id="signed-out" hidden>Sign in to make short links. <a href="/login">Sign in</a></p>
<form id="create" hidden>
<label>Link to <input name="url" type="url" required maxlength="2048" placeholder="https://example.com/a/long/page"></label>
<label>Code (optional) <input name="code" pattern="[a-z0-9-]{3,32}" maxlength="32" placeholder="random"></label>
<button>Shorten</button>
</form>
<p id="message" role="status"></p>
<ul id="links"></ul>
</main>
</body>
</html>
`;

export const js = `'use strict';
const $ = id => document.getElementById(id);
const say = text => { $('message').textContent = text; };

async function api(path, init) {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json' } });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? 'Something went wrong.'), { status: response.status });
  return body;
}

function row(link) {
  const item = document.createElement('li');
  const short = document.createElement('a');
  short.href = link.shortUrl;
  short.textContent = link.shortUrl;
  const target = document.createElement('span');
  target.textContent = ' -> ' + link.url + ' (' + link.clicks + (link.clicks === 1 ? ' click) ' : ' clicks) ');
  const remove = document.createElement('button');
  remove.textContent = 'Delete';
  remove.addEventListener('click', async () => {
    try { await api('/api/links/' + link.id, { method: 'DELETE' }); item.remove(); } catch (error) { say(error.message); }
  });
  item.append(short, target, remove);
  return item;
}

async function load() {
  try {
    const { items } = await api('/api/links');
    $('create').hidden = false;
    $('links').replaceChildren(...items.map(row));
  } catch (error) {
    if (error.status === 401) $('signed-out').hidden = false;
    else say(error.message);
  }
}

$('create').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const input = { url: form.url.value };
  if (form.code.value) input.code = form.code.value;
  try {
    const link = await api('/api/links', { method: 'POST', body: JSON.stringify(input) });
    $('links').prepend(row(link));
    form.reset();
    say('Made ' + link.shortUrl);
  } catch (error) { say(error.message); }
});

load();
`;

export const css = `body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #fafafa; color: #111; }
main { max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
form { display: grid; gap: .75rem; margin-bottom: 1rem; }
label { display: grid; gap: .25rem; }
input, button { font: inherit; padding: .5rem; border: 1px solid #888; border-radius: 4px; }
button { cursor: pointer; background: #111; color: #fff; }
ul { list-style: none; padding: 0; }
li { padding: .5rem 0; border-top: 1px solid #ddd; overflow-wrap: anywhere; }
li button { padding: .1rem .5rem; margin-left: .5rem; background: #fff; color: #111; }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #eee; }
  a { color: #8bf; }
  button { background: #eee; color: #111; }
  li button { background: #111; color: #eee; }
  li { border-color: #333; }
}
`;
