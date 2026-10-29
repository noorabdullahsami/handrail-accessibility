// Drives test/preview.html: the form picks the state, theme and width, and
// the address keeps them, so a link opens the same view.
const form = document.getElementById('choices');
const frame = document.getElementById('panel');

// Start from the address, if it says anything.
const start = new URLSearchParams(location.search);
for (const [name, value] of start) {
  const field = form.elements[name];
  if (field) field.value = value;
}

function show() {
  const data = new FormData(form);
  const state = data.get('state');
  // The frame follows prefers-color-scheme; Chrome takes it from the
  // iframe's color-scheme here.
  frame.style.colorScheme = data.get('theme');
  frame.style.width = `${data.get('width')}px`;
  frame.src = `preview/panel.html?state=${state}`;
  history.replaceState(null, '', `?${new URLSearchParams(data)}`);
}

form.addEventListener('change', show);
show();
