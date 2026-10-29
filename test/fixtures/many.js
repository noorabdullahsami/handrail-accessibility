const list = document.getElementById('links');
for (let i = 1; i <= 600; i++) {
  const item = document.createElement('li');
  item.innerHTML = `<a href="/page-${i}">Page ${i}</a>`;
  list.append(item);
}
