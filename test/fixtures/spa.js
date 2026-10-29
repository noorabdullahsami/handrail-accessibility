const views = {
  home: '<h1>Home</h1><p>Tab down the page and watch the sticky header.</p><div class="spacer"></div><a href="#top">A link far down the page</a>',
  about: '<h1>About</h1><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40"><p>This view has an image with no alt text.</p>',
};
function render() {
  document.getElementById('view').innerHTML = location.pathname.endsWith('spa-about') ? views.about : views.home;
}
for (const button of document.querySelectorAll('[data-route]')) {
  button.addEventListener('click', () => {
    history.pushState(null, '', button.dataset.route);
    render();
  });
}
window.addEventListener('popstate', render);
render();
